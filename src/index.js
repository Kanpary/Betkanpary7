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

// CORS e parsing
app.use(cors({
  origin: '*',
  methods: ['GET','POST','PUT','DELETE','OPTIONS'],
  allowedHeaders: ['Content-Type','Authorization']
}));
app.use(bodyParser.json({ limit: '1mb' }));
app.use(bodyParser.urlencoded({ extended: true }));

// Inicializa banco
await init();

// Paths estáticos
const dirname = path.dirname(fileURLToPath(import.meta.url));
const webDir = path.join(dirname, '..', 'web');
app.use(express.static(webDir));

// Util: normalizar valores em reais → centavos
function toCents(v) {
  const n = Number(v);
  if (Number.isNaN(n) || n <= 0) return 0;
  return Math.round(n * 100);
}
// Util: exibir centavos como reais
function fromCents(c) {
  return Number(c) / 100;
}

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

  // Cria carteira com saldo inicial 500 reais (50000 centavos)
  await pool.query(
    `INSERT INTO wallets (user_id, balance, hold) VALUES ($1, 50000, 0)
     ON CONFLICT (user_id) DO NOTHING`,
    [userId]
  );
  return userId;
}

// ===================== Rotas públicas =====================

// Login
app.post('/login', async (req, res) => {
  try {
    const { email } = req.body;
    if (!email) return res.status(400).json({ error: 'E-mail é obrigatório' });
    const userId = await getOrCreateUser(email);
    res.json({ userId, email });
  } catch (err) {
    console.error('Erro no login:', err);
    res.status(500).json({ error: 'Erro interno no login' });
  }
});

// Carteira (retorna em reais)
app.get('/wallet/:userId', async (req, res) => {
  try {
    const { userId } = req.params;
    const result = await pool.query(
      'SELECT balance, hold FROM wallets WHERE user_id = $1',
      [userId]
    );
    if (!result.rows.length) return res.status(404).json({ error: 'Carteira não encontrada' });

    const { balance, hold } = result.rows[0];
    res.json({ balance: fromCents(balance), hold: fromCents(hold) });
  } catch (err) {
    console.error('Erro ao buscar carteira:', err);
    res.status(500).json({ error: 'Erro interno ao buscar carteira' });
  }
});

// Criar depósito (Pix via BullsPay) — amount em reais
app.post('/deposit', async (req, res) => {
  try {
    const { email, amount, currency } = req.body;
    if (!email || !amount) {
      return res.status(400).json({ error: 'E-mail e amount são obrigatórios' });
    }
    if (amount < 6) {
      return res.status(400).json({ error: 'O valor mínimo para depósito é R$ 6,00' });
    }

    const userId = await getOrCreateUser(email);

    const paymentData = await createPaymentIntent({
      amount: toCents(amount), // envia em centavos
      currency: currency || 'BRL',
      userRef: userId
    });

    await pool.query(
      `INSERT INTO payments (user_id, amount, currency, type, status, raw)
       VALUES ($1, $2, $3, $4, $5, $6)`,
      [userId, toCents(amount), currency || 'BRL', 'deposit', paymentData.status, JSON.stringify(paymentData)]
    );

    const qrCodeUrl = paymentData.pixQrCode || null;
    const qrCodeBase64 = paymentData.qr_code_base64 || null;
    const copiaCola = paymentData.pixCopiaCola || paymentData.qr_code_text || paymentData.pixCopiaECola || null;

    res.json({
      status: paymentData.status,
      pixQrCode: qrCodeUrl,
      qr_code_base64: qrCodeBase64,
      pixCopiaCola: copiaCola,
      checkoutUrl: paymentData.checkoutUrl || null
    });
  } catch (err) {
    console.error('Erro no depósito:', err);
    res.status(500).json({ error: err.message || 'Erro no depósito' });
  }
});

// Criar saque (payout) — amount em reais
app.post('/payout', async (req, res) => {
  try {
    const { email, amount, currency, destination } = req.body;
    if (!email || !amount || !destination) {
      return res.status(400).json({ error: 'E-mail, amount e destino são obrigatórios' });
    }

    const userId = await getOrCreateUser(email);

    const cents = toCents(amount);
    const w = await pool.query('SELECT balance FROM wallets WHERE user_id=$1', [userId]);
    if (!w.rows.length) return res.status(404).json({ error: 'Carteira não encontrada' });
    if (Number(w.rows[0].balance) < cents) {
      return res.status(400).json({ error: 'Saldo insuficiente' });
    }

    await pool.query('UPDATE wallets SET balance = balance - $1 WHERE user_id = $2', [cents, userId]);

    const payoutData = await createPayout({
      amount: toCents(amount),
      currency: currency || 'BRL',
      userRef: userId,
      destination
    });

    await pool.query(
      `INSERT INTO payments (user_id, amount, currency, type, status, raw)
       VALUES ($1, $2, $3, $4, $5, $6)`,
      [userId, cents, currency || 'BRL', 'payout', payoutData.status, JSON.stringify(payoutData)]
    );

    res.json(payoutData);
  } catch (err) {
    console.error('Erro no saque:', err);
    res.status(500).json({ error: err.message || 'Erro no saque' });
  }
});

// ===================== Jogo: Raspadinha =====================

app.post('/scratch/play', async (req, res) => {
  try {
    const { userId, bet } = req.body;
    if (!userId || !bet) {
      return res.status(400).json({ error: 'Parâmetros obrigatórios: userId e bet' });
    }

    const cents = toCents(bet);
    if (cents <= 0) return res.status(400).json({ error: 'Valor de aposta inválido' });

    const r = await pool.query('SELECT balance FROM wallets WHERE user_id = $1', [userId]);
    if (!r.rows.length) return res.status(404).json({ error: 'Carteira não encontrada' });
    const balance = Number(r.rows[0].balance);
    if (balance < cents) return res.status(400).json({ error: 'Saldo insuficiente' });

    // Debita aposta
    await pool.query('UPDATE wallets SET balance = balance - $1 WHERE user_id = $2', [cents, userId]);

    // Sorteio simples de prêmios em centavos
    const poolPrizes = [0,0,0,0,100,200,500,1000,2000,5000];
    const prize = poolPrizes[Math.floor(Math.random() * poolPrizes.length)];

    if (prize > 0) {
      await pool.query('UPDATE wallets SET balance = balance + $1 WHERE user_id = $2', [prize, userId]);
    }

    const finalBalance = balance - cents + prize;
    res.json({
      bet: fromCents(cents),
      prize: fromCents(prize),
      finalBalance: fromCents(finalBalance)
    });
  } catch (err) {
    console.error('Erro na raspadinha:', err);
    res.status(500).json({ error: 'Erro interno na raspadinha' });
  }
});

// ===================== Jogo: Raspadinha =====================

// Jogar raspadinha
app.post('/scratch/play', async (req, res) => {
  try {
    const { userId, bet } = req.body;
    if (!userId || !bet) {
      return res.status(400).json({ error: 'Parâmetros obrigatórios: userId e bet' });
    }

    const cents = toCents(bet);
    if (cents <= 0) return res.status(400).json({ error: 'Valor de aposta inválido' });

    const w = await pool.query('SELECT balance FROM wallets WHERE user_id=$1', [userId]);
    if (!w.rows.length) return res.status(404).json({ error: 'Carteira não encontrada' });
    if (Number(w.rows[0].balance) < cents) {
      return res.status(400).json({ error: 'Saldo insuficiente' });
    }

    // Debita aposta
    await pool.query('UPDATE wallets SET balance = balance - $1 WHERE user_id = $2', [cents, userId]);

    // Sorteio simples de prêmios em centavos
    const poolPrizes = [0,0,0,0,100,200,500,1000,2000,5000];
    const prize = poolPrizes[Math.floor(Math.random() * poolPrizes.length)];

    // Credita prêmio se houver
    if (prize > 0) {
      await pool.query('UPDATE wallets SET balance = balance + $1 WHERE user_id = $2', [prize, userId]);
    }

    const finalBalance = Number(w.rows[0].balance) - cents + prize;
    res.json({
      bet: fromCents(cents),
      prize: fromCents(prize),
      finalBalance: fromCents(finalBalance)
    });
  } catch (err) {
    console.error('Erro na raspadinha:', err);
    res.status(500).json({ error: 'Erro interno na raspadinha' });
  }
});

// ===================== Bullspay =====================

// Webhook Bullspay
app.post('/webhook/bullspay', async (req, res) => {
  try {
    const payload = req.body;
    console.log('Webhook BullsPay:', JSON.stringify(payload, null, 2));

    const transactionId = payload?.data?.payment_data?.id;
    const status = payload?.data?.status || payload?.data?.payment_data?.status;

    if (!transactionId) return res.status(400).json({ error: 'Transação inválida' });

    // Atualiza status do pagamento
    await pool.query(
      `UPDATE payments SET status = $1, raw = $2 
       WHERE raw->'data'->'payment_data'->>'id' = $3`,
      [status, JSON.stringify(payload), transactionId]
    );

    // Se pago, creditar carteira
    if (status === 'paid') {
      const result = await pool.query(
        `SELECT user_id, amount FROM payments 
         WHERE raw->'data'->'payment_data'->>'id' = $1 AND type = 'deposit'`,
        [transactionId]
      );

      if (result.rows.length > 0) {
        const { user_id, amount } = result.rows[0]; // amount já em centavos
        await pool.query(
          'UPDATE wallets SET balance = balance + $1 WHERE user_id = $2',
          [amount, user_id]
        );
        console.log(`💰 Crédito realizado para usuário ${user_id}, valor R$ ${fromCents(amount)}`);
      }
    }

    res.json({ ok: true });
  } catch (err) {
    console.error('Erro no webhook:', err);
    res.status(500).json({ error: 'Erro interno' });
  }
});

// ===================== Front fallback e saúde =====================

// Health check
app.get('/health', (req, res) => {
  res.json({ ok: true, ts: new Date().toISOString() });
});

// SPA fallback: entrega index.html para rotas não-API
app.get('*', (req, res, next) => {
  // Se for rota de API, pula
  if (req.path.startsWith('/login') ||
      req.path.startsWith('/wallet') ||
      req.path.startsWith('/deposit') ||
      req.path.startsWith('/payout') ||
      req.path.startsWith('/scratch') ||
      req.path.startsWith('/webhook') ||
      req.path.startsWith('/health')) {
    return next();
  }
  res.sendFile(path.join(webDir, 'index.html'));
});

// Inicialização do servidor
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`Servidor rodando na porta ${PORT}`);
});
