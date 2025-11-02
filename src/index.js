import express from 'express';
import cors from 'cors';
import dotenv from 'dotenv';
import bodyParser from 'body-parser';
import path from 'path';
import { fileURLToPath } from 'url';
import { pool, init } from './db.js';
import { v4 as uuidv4 } from 'uuid';
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

  // Cria carteira com saldo inicial de R$ 500,00 (50000 centavos)
  await pool.query(
    `INSERT INTO wallets (user_id, balance) VALUES ($1, 50000)
     ON CONFLICT (user_id) DO NOTHING`,
    [userId]
  );

  return userId;
}

// ✅ Rota de login
app.post('/login', async (req, res) => {
  try {
    const { email } = req.body;
    if (!email) {
      return res.status(400).json({ error: 'E-mail é obrigatório' });
    }

    const userId = await getOrCreateUser(email);
    res.json({ userId, email });
  } catch (err) {
    console.error('Erro no login:', err);
    res.status(500).json({ error: 'Erro interno no login' });
  }
});

// ✅ Rota para consultar carteira
app.get('/wallet/:userId', async (req, res) => {
  try {
    const { userId } = req.params;
    const result = await pool.query(
      'SELECT balance, hold FROM wallets WHERE user_id = $1',
      [userId]
    );

    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'Carteira não encontrada' });
    }

    res.json(result.rows[0]);
  } catch (err) {
    console.error('Erro ao buscar carteira:', err);
    res.status(500).json({ error: 'Erro interno ao buscar carteira' });
  }
});

// ✅ Rota para criar um depósito (payment intent)
app.post('/deposit', async (req, res) => {
  try {
    const { email, amount, currency } = req.body;

    const userId = await getOrCreateUser(email);

    const paymentData = await createPaymentIntent({
      amount,
      currency,
      userRef: userId
    });

    console.log('Resposta BullsPay:', paymentData);

    // Normaliza os campos para sempre devolver QR e Copia e Cola
    const qrCodeUrl = paymentData.pixQrCode || null;
    const qrCodeBase64 = paymentData.qr_code_base64 || null;
    const copiaCola =
      paymentData.pixCopiaCola ||
      paymentData.qr_code_text ||
      paymentData.pixCopiaECola ||
      null;

    await pool.query(
      `INSERT INTO payments (user_id, amount, currency, type, status, raw)
       VALUES ($1, $2, $3, $4, $5, $6)`,
      [
        userId,
        amount,
        currency || 'BRL',
        'deposit',
        paymentData.status,
        JSON.stringify(paymentData)
      ]
    );

    res.json({
      status: paymentData.status,
      pixQrCode: qrCodeUrl,
      qr_code_base64: qrCodeBase64,
      pixCopiaCola: copiaCola,
      checkoutUrl: paymentData.checkoutUrl || null
    });
  } catch (err) {
    console.error('Erro no depósito:', err);
    res.status(500).json({ error: err.message });
  }
});

// ✅ Rota para criar um saque (payout)
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

// ✅ Rota de aposta (roleta)
app.post('/bet', async (req, res) => {
  try {
    const { userId, amount, betType, betValue } = req.body;

    // Busca carteira
    const result = await pool.query('SELECT balance FROM wallets WHERE user_id = $1', [userId]);
    if (result.rows.length === 0) return res.status(404).json({ error: 'Carteira não encontrada' });

    const balance = result.rows[0].balance;
    if (balance < amount) return res.status(400).json({ error: 'Saldo insuficiente' });

    // Debita aposta
    await pool.query('UPDATE wallets SET balance = balance - $1 WHERE user_id = $2', [amount, userId]);

    // Sorteia número da roleta (0 a 36)
    const outcome = Math.floor(Math.random() * 37);
    let win = 0;

    if (betType === 'number' && parseInt(betValue) === outcome) {
      win = amount * 35; // paga 35x
    } else if (betType === 'color') {
      const redNumbers = [1,3,5,7,9,12,14,16,18,19,21,23,25,27,30,32,34,36];
      const blackNumbers = [2,4,6,8,10,11,13,15,17,20,22,24,26,28,29,31,33,35];
      let color = 'green';
      if (redNumbers.includes(outcome)) color = 'red';
      else if (blackNumbers.includes(outcome)) color = 'black';

      if (betValue === color) {
        win = amount * 2; // paga 2x
      }
    }

    if (win > 0) {
      await pool.query('UPDATE wallets SET balance = balance + $1 WHERE user_id = $2', [win, userId]);
    }

    res.json({ outcome, win, finalBalance: balance - amount + win });
  } catch (err) {
    console.error('Erro na aposta:', err);
    res.status(500).json({ error: 'Erro interno na aposta' });
  }
});

// ✅ Webhook da BullsPay para atualização de status
app.post('/webhook/bullspay', async (req, res) => {
  try {
    const payload = req.body;
    console.log("Webhook recebido:", JSON.stringify(payload, null, 2));

    const transactionId = payload?.data?.payment_data?.id;
    const status = payload?.data?.status || payload?.data?.payment_data?.status;

    if (!transactionId) {
      return res.status(400).json({ error: 'Transação inválida' });
    }

    // Atualiza status no banco
    await pool.query(
      `UPDATE payments SET status = $1, raw = $2 
       WHERE raw->'data'->'payment_data'->>'id' = $3`,
      [status, JSON.stringify(payload), transactionId]
    );

    // Se pago, credita saldo
    if (status === 'paid') {
      const result = await pool.query(
        `SELECT user_id, amount FROM payments 
         WHERE raw->'data'->'payment_data'->>'id' = $1`,
        [transactionId]
      );

      if (result.rows.length > 0) {
        const { user_id, amount } = result.rows[0];
        await pool.query(
          `UPDATE wallets SET balance = balance + $1 WHERE user_id = $2`,
          [amount, user_id]
        );
        console.log(`💰 Crédito realizado para usuário ${user_id}, valor ${amount}`);
      }
    }

    res.json({ ok: true });
  } catch (err) {
    console.error("Erro no webhook:", err);
    res.status(500).json({ error: 'Erro interno' });
  }
});

// ✅ Rota de health check para o Render
app.get('/', (req, res) => {
  res.send('API online 🚀');
});

// Inicialização do servidor
const PORT = process.env.PORT || 3000;

app.listen(PORT, () => {
  console.log(`Servidor rodando na porta ${PORT}`);
});
