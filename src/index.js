import express from 'express';
import cors from 'cors';
import bodyParser from 'body-parser';
import dotenv from 'dotenv';
import path from 'path';
import { fileURLToPath } from 'url';
import { Pool } from 'pg';
import { createPaymentIntent, createPayout } from './bullspay.js';

dotenv.config();

const app = express();
const PORT = process.env.PORT || 8080;

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

app.use(cors());
app.use(bodyParser.json());
app.use(express.static(path.join(__dirname, '..', 'web')));

app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, '..', 'web', 'index.html'));
});

// PostgreSQL
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false }
});

// ==================== ENDPOINTS ====================

// Cadastro
app.post('/register', async (req, res) => {
  const { username, email, password, cpf } = req.body;
  if (!username || !email || !password || !cpf) {
    return res.status(400).json({ error: 'Todos os campos são obrigatórios' });
  }

  try {
    const existing = await pool.query('SELECT id FROM users WHERE email = $1 OR cpf = $2', [email, cpf]);
    if (existing.rows.length > 0) {
      return res.status(400).json({ error: 'Email ou CPF já cadastrado' });
    }

    const result = await pool.query(
      'INSERT INTO users (username, email, password, cpf) VALUES ($1, $2, $3, $4) RETURNING id',
      [username, email, password, cpf]
    );

    res.json({ userId: result.rows[0].id, email });
  } catch (err) {
    console.error('Erro ao registrar usuário:', err);
    res.status(500).json({ error: 'Erro interno ao registrar' });
  }
});

// Login
app.post('/login', async (req, res) => {
  const { email, password } = req.body;
  if (!email || !password) return res.status(400).json({ error: 'Email e senha obrigatórios' });

  try {
    const result = await pool.query('SELECT id, password FROM users WHERE email = $1', [email]);
    if (result.rows.length === 0 || result.rows[0].password !== password) {
      return res.status(401).json({ error: 'Credenciais inválidas' });
    }

    res.json({ userId: result.rows[0].id, email });
  } catch (err) {
    console.error('Erro ao autenticar:', err);
    res.status(500).json({ error: 'Erro interno no login' });
  }
});

// Carteira
app.get('/wallet/:userId', async (req, res) => {
  const userId = req.params.userId;
  try {
    const result = await pool.query('SELECT balance, hold FROM users WHERE id = $1', [userId]);
    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'Usuário não encontrado' });
    }

    res.json({
      balance: result.rows[0].balance,
      hold: result.rows[0].hold
    });
  } catch (err) {
    console.error('Erro ao buscar saldo:', err);
    res.status(500).json({ error: 'Erro interno ao buscar carteira' });
  }
});

// Depósito
app.post('/deposit', async (req, res) => {
  const { userId, amount, currency = 'BRL', buyer_document } = req.body;
  if (!userId || !amount || !buyer_document) {
    return res.status(400).json({ error: 'Dados obrigatórios ausentes' });
  }

  try {
    const userRes = await pool.query('SELECT * FROM users WHERE id = $1', [userId]);
    const user = userRes.rows[0];
    if (!user) return res.status(404).json({ error: 'Usuário não encontrado' });

    const intent = await createPaymentIntent({
      amount,
      currency,
      userRef: user.id,
      buyer: {
        name: user.username,
        email: user.email,
        buyer_document
      }
    });

    await pool.query(
      'INSERT INTO transactions (user_id, type, amount, status, balance_after) VALUES ($1, $2, $3, $4, $5)',
      [user.id, 'deposit', amount, intent.status, user.balance]
    );

    res.json(intent);
  } catch (err) {
    console.error('Erro ao criar depósito:', err);
    res.status(500).json({ error: 'Falha ao criar depósito', details: err.message });
  }
});

// Saque
app.post('/payout', async (req, res) => {
  const { userId, amount, currency = 'BRL', destination } = req.body;
  if (!userId || !amount || !destination) {
    return res.status(400).json({ error: 'Dados obrigatórios ausentes' });
  }

  if (amount > 500) {
    return res.status(400).json({ error: 'Valor máximo de saque é R$ 500,00' });
  }

  try {
    const userRes = await pool.query('SELECT * FROM users WHERE id = $1', [userId]);
    const user = userRes.rows[0];
    if (!user) return res.status(404).json({ error: 'Usuário não encontrado' });
    if (user.balance < amount) {
      return res.status(400).json({ error: 'Saldo insuficiente' });
    }

    const taxa = amount * 0.03;
    const valorLiquido = amount - taxa;
    const novoSaldo = user.balance - amount;

    const payout = await createPayout({
      amount: valorLiquido,
      currency,
      userRef: user.id,
      destination
    });

    await pool.query('UPDATE users SET balance = $1 WHERE id = $2', [novoSaldo, user.id]);

    await pool.query(
      'INSERT INTO transactions (user_id, type, amount, status, balance_after) VALUES ($1, $2, $3, $4, $5)',
      [user.id, 'withdraw', -amount, payout.status, novoSaldo]
    );

    res.json({
      ...payout,
      solicitado: amount,
      taxa,
      liquido: valorLiquido
    });
  } catch (err) {
    console.error('Erro ao solicitar saque:', err);
    res.status(500).json({ error: 'Falha ao solicitar saque', details: err.message });
  }
});

// Histórico
app.get('/transactions/:userId', async (req, res) => {
  const userId = req.params.userId;
  try {
    const result = await pool.query(
      'SELECT * FROM transactions WHERE user_id = $1 ORDER BY created_at DESC LIMIT 10',
      [userId]
    );
    res.json({ items: result.rows });
  } catch (err) {
    console.error('Erro ao buscar transações:', err);
    res.status(500).json({ error: 'Erro interno ao buscar histórico' });
  }
});

// Raspadinha
app.post('/scratch/play', async (req, res) => {
  const { userId, bet } = req.body;
  if (!userId || !bet || bet <= 0) {
    return res.status(400).json({ error: 'Dados inválidos' });
  }

  try {
    const userRes = await pool.query('SELECT * FROM users WHERE id = $1', [userId]);
    const user = userRes.rows[0];
    if (!user) return res.status(404).json({ error: 'Usuário não encontrado' });
    if (user.balance < bet) return res.status(400).json({ error: 'Saldo insuficiente' });

    let prize = 0;
    const rtp = 0.92;
    const chance = Math.random();

    let novoSaldo = user.balance - bet;
    if (chance < rtp) {
      const multiplier = 0.2 + Math.random() * 1.8;
      prize = Number((bet * multiplier).toFixed(2));
      novoSaldo += prize;
    }

    await pool.query('UPDATE users SET balance = $1 WHERE id = $2', [novoSaldo, user.id]);

    await pool.query(
      'INSERT INTO transactions (user_id, type, amount, status, balance_after) VALUES ($1, $2, $3, $4, $5)',
      [user.id, 'scratch', prize - bet, 'finished', novoSaldo]
    );

    res.json({ prize, finalBalance: novoSaldo });
  } catch (err) {
    console.error('Erro ao jogar raspadinha:', err);
    res.status(500).json({ error: 'Erro interno na raspadinha' });
  }
});

// Webhook BullsPay
app.post('/webhook/bullspay', (req, res) => {
  console.log('Webhook BullsPay recebido:', JSON.stringify(req.body, null, 2));
  res.json({ ok: true });
});

// Inicia servidor
app.listen(PORT, () => {
  console.log(`Servidor rodando na porta ${PORT}`);
});
