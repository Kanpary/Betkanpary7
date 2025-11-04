import express from 'express';
import cors from 'cors';
import bodyParser from 'body-parser';
import dotenv from 'dotenv';
import path from 'path';
import { fileURLToPath } from 'url';
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

// "Banco" em memória
const users = {}; // { userId: { username, email, password, cpf, balance, hold, transactions: [] } }

// ==================== FUNÇÕES ====================

function getUserById(id) {
  return users[id] || null;
}

function getUserByEmail(email) {
  return Object.values(users).find(u => u.email === email);
}

// ==================== ENDPOINTS ====================

// Cadastro
app.post('/register', (req, res) => {
  const { username, email, password, cpf } = req.body;
  if (!username || !email || !password || !cpf) {
    return res.status(400).json({ error: 'Todos os campos são obrigatórios' });
  }

  if (getUserByEmail(email)) {
    return res.status(400).json({ error: 'Email já cadastrado' });
  }

  const id = 'u' + Date.now();
  users[id] = {
    id, username, email, password, cpf,
    balance: 0, hold: 0, transactions: []
  };

  res.json({ userId: id, email });
});

// Login
app.post('/login', (req, res) => {
  const { email, password } = req.body;
  if (!email || !password) return res.status(400).json({ error: 'Email e senha são obrigatórios' });

  const user = getUserByEmail(email);
  if (!user || user.password !== password) {
    return res.status(401).json({ error: 'Credenciais inválidas' });
  }

  res.json({ userId: user.id, email: user.email });
});

// Carteira
app.get('/wallet/:userId', (req, res) => {
  const user = getUserById(req.params.userId);
  if (!user) return res.status(404).json({ error: 'Usuário não encontrado' });

  res.json({ balance: user.balance, hold: user.hold });
});

// Depósito
app.post('/deposit', async (req, res) => {
  const { userId, amount, currency = 'BRL', buyer_document } = req.body;
  if (!userId || !amount || !buyer_document) {
    return res.status(400).json({ error: 'Dados obrigatórios ausentes' });
  }

  const user = getUserById(userId);
  if (!user) return res.status(404).json({ error: 'Usuário não encontrado' });

  try {
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

    user.transactions.push({
      type: 'deposit',
      amount,
      status: intent.status,
      created_at: new Date(),
      balance_after: user.balance
    });

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

  const user = getUserById(userId);
  if (!user) return res.status(404).json({ error: 'Usuário não encontrado' });
  if (user.balance < amount) {
    return res.status(400).json({ error: 'Saldo insuficiente' });
  }

  const taxa = amount * 0.03;
  const valorLiquido = amount - taxa;

  try {
    const payout = await createPayout({
      amount: valorLiquido,
      currency,
      userRef: user.id,
      destination
    });

    user.balance -= amount;
    user.transactions.push({
      type: 'withdraw',
      amount: -amount,
      status: payout.status,
      created_at: new Date(),
      balance_after: user.balance
    });

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
app.get('/transactions/:userId', (req, res) => {
  const user = getUserById(req.params.userId);
  if (!user) return res.status(404).json({ error: 'Usuário não encontrado' });

  const limit = parseInt(req.query.limit || '10', 10);
  const items = user.transactions.slice(-limit).reverse();
  res.json({ items });
});

// Raspadinha
app.post('/scratch/play', (req, res) => {
  const { userId, bet } = req.body;
  const user = getUserById(userId);
  if (!user) return res.status(404).json({ error: 'Usuário não encontrado' });
  if (!bet || bet <= 0) return res.status(400).json({ error: 'Aposta inválida' });
  if (user.balance < bet) return res.status(400).json({ error: 'Saldo insuficiente' });

  user.balance -= bet;

  const rtp = 0.92;
  const chance = Math.random();
  let prize = 0;

  if (chance < rtp) {
    const multiplier = 0.2 + Math.random() * 1.8;
    prize = Number((bet * multiplier).toFixed(2));
    user.balance += prize;
  }

  user.transactions.push({
    type: 'scratch',
    amount: prize - bet,
    status: 'finished',
    created_at: new Date(),
    balance_after: user.balance
  });

  res.json({ prize, finalBalance: user.balance });
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
