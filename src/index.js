// src/index.js
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

// Necessário para resolver __dirname em ES modules
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Middlewares
app.use(cors());
app.use(bodyParser.json());

// ✅ Servir arquivos estáticos da pasta "web"
app.use(express.static(path.join(__dirname, '..', 'web')));

// ✅ Rota raiz entrega o index.html
app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, '..', 'web', 'index.html'));
});

// "Banco" em memória (para testes)
const users = {}; // { userId: { email, balance, hold, transactions: [] } }

// Função utilitária
function getOrCreateUser(email) {
  let user = Object.values(users).find(u => u.email === email);
  if (!user) {
    const id = 'u' + Date.now();
    user = { id, email, balance: 0, hold: 0, transactions: [] };
    users[id] = user;
  }
  return user;
}

// ==================== ENDPOINTS ====================

// Login
app.post('/login', (req, res) => {
  const { email } = req.body;
  if (!email) return res.status(400).json({ error: 'E-mail é obrigatório' });

  const user = getOrCreateUser(email);
  res.json({ userId: user.id, email: user.email });
});

// Carteira
app.get('/wallet/:userId', (req, res) => {
  const user = users[req.params.userId];
  if (!user) return res.status(404).json({ error: 'Usuário não encontrado' });

  res.json({ balance: user.balance, hold: user.hold });
});

// Depósito
app.post('/deposit', async (req, res) => {
  const { email, amount, currency = 'BRL', buyer_document } = req.body;
  if (!email || !amount) return res.status(400).json({ error: 'Email e valor são obrigatórios' });
  if (!buyer_document) return res.status(400).json({ error: 'Documento do comprador é obrigatório' });

  const user = getOrCreateUser(email);

  try {
    const intent = await createPaymentIntent({
      amount,
      currency,
      userRef: user.id,
      buyer: { name: email, email, buyer_document }
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

// Saque (com limite de R$500 e taxa de 3%)
app.post('/payout', async (req, res) => {
  const { email, amount, currency = 'BRL', destination } = req.body;
  if (!email || !amount || !destination) {
    return res.status(400).json({ error: 'Dados obrigatórios ausentes' });
  }

  if (amount > 500) {
    return res.status(400).json({ error: 'Valor máximo de saque é R$ 500,00' });
  }

  const user = getOrCreateUser(email);
  if (user.balance < amount) {
    return res.status(400).json({ error: 'Saldo insuficiente' });
  }

  // aplica taxa de 3%
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
  const user = users[req.params.userId];
  if (!user) return res.status(404).json({ error: 'Usuário não encontrado' });

  const limit = parseInt(req.query.limit || '10', 10);
  const items = user.transactions.slice(-limit).reverse();
  res.json({ items });
});

// Raspadinha (RTP configurado em 92%)
app.post('/scratch/play', (req, res) => {
  const { userId, bet } = req.body;
  const user = users[userId];
  if (!user) return res.status(404).json({ error: 'Usuário não encontrado' });
  if (!bet || bet <= 0) return res.status(400).json({ error: 'Aposta inválida' });
  if (user.balance < bet) return res.status(400).json({ error: 'Saldo insuficiente' });

  // debita aposta
  user.balance -= bet;

  // RTP 92%: expectativa de retorno
  const rtp = 0.92;
  const chance = Math.random();
  let prize = 0;

  if (chance < rtp) {
    // prêmio aleatório entre 0.2x e 2x a aposta
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
