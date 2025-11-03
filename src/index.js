// src/index.js
import express from 'express';
import cors from 'cors';
import bodyParser from 'body-parser';
import dotenv from 'dotenv';

import { createPaymentIntent, createPayout } from './bullspay.js';

dotenv.config();

const app = express();
const PORT = process.env.PORT || 8080;

// Middlewares
app.use(cors());
app.use(bodyParser.json());

// In-memory "database" simples para testes
const users = {}; // { userId: { email, balance, hold, transactions: [] } }

// Função utilitária para criar ou obter usuário
function getOrCreateUser(email) {
  let user = Object.values(users).find(u => u.email === email);
  if (!user) {
    const id = 'u' + Date.now();
    user = { id, email, balance: 0, hold: 0, transactions: [] };
    users[id] = user;
  }
  return user;
}

// Endpoint de login
app.post('/login', (req, res) => {
  const { email } = req.body;
  if (!email) return res.status(400).json({ error: 'E-mail é obrigatório' });

  const user = getOrCreateUser(email);
  res.json({ userId: user.id, email: user.email });
});

// Endpoint para consultar carteira
app.get('/wallet/:userId', (req, res) => {
  const user = users[req.params.userId];
  if (!user) return res.status(404).json({ error: 'Usuário não encontrado' });

  res.json({ balance: user.balance, hold: user.hold });
});

// Endpoint de depósito
app.post('/deposit', async (req, res) => {
  const { email, amount, currency = 'BRL', buyer_document } = req.body;
  if (!email || !amount) return res.status(400).json({ error: 'Email e valor são obrigatórios' });
  if (!buyer_document) return res.status(400).json({ error: 'Documento do comprador é obrigatório (CPF ou CNPJ)' });

  const user = getOrCreateUser(email);

  try {
    const intent = await createPaymentIntent({
      amount,
      currency,
      userRef: user.id,
      buyer: {
        name: email,
        email,
        buyer_document
      }
    });

    // registra transação pendente
    user.transactions.push({
      type: 'deposit',
      amount,
      status: intent.status,
      created_at: new Date(),
      balance_after: user.balance
    });

    res.json(intent);
  } catch (err) {
    console.error('Erro ao criar payment intent:', err);
    res.status(500).json({ error: 'Falha ao criar depósito', details: err.message });
  }
});

// Endpoint de saque
app.post('/payout', async (req, res) => {
  const { email, amount, currency = 'BRL', destination } = req.body;
  if (!email || !amount || !destination) return res.status(400).json({ error: 'Dados obrigatórios ausentes' });

  const user = getOrCreateUser(email);
  if (user.balance < amount) return res.status(400).json({ error: 'Saldo insuficiente' });

  try {
    const payout = await createPayout({
      amount,
      currency,
      userRef: user.id,
      destination
    });

    // debita saldo e registra transação
    user.balance -= amount;
    user.transactions.push({
      type: 'withdraw',
      amount: -amount,
      status: payout.status,
      created_at: new Date(),
      balance_after: user.balance
    });

    res.json(payout);
  } catch (err) {
    console.error('Erro ao solicitar saque:', err);
    res.status(500).json({ error: 'Falha ao solicitar saque', details: err.message });
  }
});

// Endpoint de histórico
app.get('/transactions/:userId', (req, res) => {
  const user = users[req.params.userId];
  if (!user) return res.status(404).json({ error: 'Usuário não encontrado' });

  const limit = parseInt(req.query.limit || '10', 10);
  const items = user.transactions.slice(-limit).reverse();
  res.json({ items });
});

// Webhook BullsPay (atualiza status de transações)
app.post('/webhook/bullspay', (req, res) => {
  console.log('Webhook BullsPay recebido:', JSON.stringify(req.body, null, 2));
  // Aqui você pode atualizar status de transações no "banco"
  res.json({ ok: true });
});

// Inicia servidor
app.listen(PORT, () => {
  console.log(`Servidor rodando na porta ${PORT}`);
});
