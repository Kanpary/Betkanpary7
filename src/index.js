// index.js

import express from 'express';
import cors from 'cors';
import dotenv from 'dotenv';
import bodyParser from 'body-parser';
import path from 'path';
import { fileURLToPath } from 'url';
import { pool, init } from './db.js';
import { v4 as uuidv4 } from 'uuid';
import CryptoJS from 'crypto-js';
import { createPaymentIntent, createPayout } from './bullspay.js';

dotenv.config();

const app = express();
app.use(cors());
app.use(bodyParser.json());

// Inicializa banco
await init();

// Configuração para servir arquivos estáticos da pasta "web"
const __dirname = path.dirname(fileURLToPath(import.meta.url));
app.use(express.static(path.join(__dirname, '..', 'web')));

// Helpers
async function getOrCreateUser(email) {
  const id = uuidv4();
  const up = await pool.query(
    `INSERT INTO users (id, email) VALUES ($1, $2)
     ON CONFLICT (email) DO UPDATE SET email = EXCLUDED.email
     RETURNING id`,
    [id, email]
  );

  const userId = up.rows[0].id;

  await pool.query(
    `INSERT INTO wallets (user_id) VALUES ($1)
     ON CONFLICT (user_id) DO NOTHING`,
    [userId]
  );

  return userId;
}

// Rota para criar um depósito (payment intent)
app.post('/deposit', async (req, res) => {
  try {
    const { email, amount, currency } = req.body;

    // garante que o usuário existe
    const userId = await getOrCreateUser(email);

    // chama a BullsPay para criar o pagamento Pix
    const paymentData = await createPaymentIntent({
      amount,
      currency,
      userRef: userId
    });

    // insere no banco (sem passar id!)
    await pool.query(
      `INSERT INTO payments (user_id, amount, currency, type, status, raw)
       VALUES ($1, $2, $3, $4, $5, $6)`,
      [
        userId,
        amount,
        currency || 'BRL',
        'pix',
        paymentData.status,
        JSON.stringify(paymentData)
      ]
    );

    res.json(paymentData);
  } catch (err) {
    console.error('Erro no depósito:', err);
    res.status(500).json({ error: err.message });
  }
});

// Rota para criar um saque (payout)
app.post('/payout', async (req, res) => {
  try {
    const { email, amount, currency, destination } = req.body;

    const userId = await getOrCreateUser(email);

    const payoutData = await createPayout({
      amount,
      currency,
      userRef: userId,
      destination
    });

    // insere no banco (sem passar id!)
    await pool.query(
      `INSERT INTO payments (user_id, amount, currency, type, status, raw)
       VALUES ($1, $2, $3, $4, $5, $6)`,
      [
        userId,
        amount,
        currency || 'BRL',
        'payout',
        payoutData.status,
        JSON.stringify(payoutData)
      ]
    );

    res.json(payoutData);
  } catch (err) {
    console.error('Erro no saque:', err);
    res.status(500).json({ error: err.message });
  }
});

// Inicialização do servidor
const PORT = process.env.PORT || 3000;

app.listen(PORT, () => {
  console.log(`Servidor rodando na porta ${PORT}`);
});
