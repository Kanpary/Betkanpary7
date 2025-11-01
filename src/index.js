import express from 'express';
import cors from 'cors';
import dotenv from 'dotenv';
import bodyParser from 'body-parser';
import path from 'path';
import { fileURLToPath } from 'url';
import { pool, init } from './db.js';
import { v4 as uuidv4 } from 'uuid';
import CryptoJS from 'crypto-js';
import { verifyWebhook, createPaymentIntent, createPayout } from './fxpay.js';

dotenv.config();
const app = express();
app.use(cors());
app.use(bodyParser.json());

// Inicializa banco
await init();

// Configuração para servir arquivos estáticos da pasta "web"
const __dirname = path.dirname(fileURLToPath(import.meta.url));
app.use(express.static(path.join(__dirname, 'web')));

// Helpers
async function getOrCreateUser(email) {
  const id = uuidv4();
  const up = await pool.query(
    `insert into users (id, email) values ($1, $2)
     on conflict (email) do update set email = excluded.email
     returning id`, [id, email]
  );
  const userId = up.rows[0].id;
  await pool.query(
    `insert into wallets (user_id) values ($1)
     on conflict (user_id) do nothing`, [userId]
  );
  return userId;
}

async function getWallet(userId) {
  const r = await pool.query(`select balance, hold from wallets where user_id=$1`, [userId]);
  return r.rows[0];
}

async function credit(userId, amount) {
  await pool.query(`update wallets set balance = balance + $2 where user_id=$1`, [userId, amount]);
}

async function hold(userId, amount) {
  await pool.query(`update wallets set balance = balance - $2, hold = hold + $2 where user_id=$1`, [userId, amount]);
}

async function releaseHold(userId, amount, confirmDebit = true) {
  await pool.query(`
    update wallets
      set hold = hold - $2,
          balance = balance + (case when $3 then 0 else $2 end)
    where user_id=$1`, [userId, amount, confirmDebit]);
}

// Health
app.get('/health', (_, res) => res.json({ ok: true }));

// Auth demo (troque por jwt/real)
app.post('/api/demo/login', async (req, res) => {
  const { email } = req.body;
  if (!email) return res.status(400).json({ error: 'email obrigatório' });
  const userId = await getOrCreateUser(email);
  res.json({ userId, email });
});

// Wallet
app.get('/api/wallet/:userId', async (req, res) => {
  const w = await getWallet(req.params.userId);
  res.json(w || { balance: 0, hold: 0 });
});

// Depósito: cria intenção e retorna checkoutUrl
app.post('/api/payments/deposit-intent', async (req, res) => {
  try {
    const { userId, amount, currency = 'BRL' } = req.body;
    if (!userId || !amount || amount <= 0) return res.status(400).json({ error: 'parâmetros inválidos' });

    const fx = await createPaymentIntent({ amount, currency, userRef: userId });
    await pool.query(`insert into payments (id, type, user_id, amount, currency, status, raw)
                      values ($1, 'payment', $2, $3, $4, $5, $6)`,
      [fx.id, userId, amount, currency, 'pending', fx]);

    res.json({ intentId: fx.id, checkoutUrl: fx.checkoutUrl });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// Saque: cria payout (coloca valor em hold)
app.post('/api/payouts/request', async (req, res) => {
  try {
    const { userId, amount, destination, currency = 'BRL' } = req.body;
    if (!userId || !amount || amount <= 0 || !destination) return res.status(400).json({ error: 'parâmetros inválidos' });

    const w = await getWallet(userId);
    if (!w || Number(w.balance) < amount) return res.status(400).json({ error: 'saldo insuficiente' });

    await hold(userId, amount);
    const fx = await createPayout({ amount, currency, userRef: userId, destination });

    await pool.query(`insert into payments (id, type, user_id, amount, currency, status, raw)
                      values ($1, 'payout', $2, $3, $4, $5, $6)`,
      [fx.id, userId, amount, currency, fx.status || 'processing', fx]);

    res.json({ payoutId: fx.id, status: fx.status || 'processing' });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// Webhook FXPay
app.post('/api/webhooks/fxpay', async (req, res) => {
  try {
    if (!verifyWebhook(req)) return res.status(401).json({ error: 'assinatura inválida' });
    const event = req.body; // { type, id, userRef, amount, currency, status }

    // idempotência
    const exists = await pool.query(`select 1 from payments where id=$1`, [event.id]);
    if (exists.rowCount === 0) {
      await pool.query(`insert into payments (id, type, user_id, amount, currency, status, raw)
                        values ($1, $2, $3, $4, $5, $6, $7)`,
        [event.id, event.type.includes('payout') ? 'payout' : 'payment',
         event.userRef, event.amount, event.currency, event.status, event]);
    } else {
      await pool.query(`update payments set status=$2, raw=$3 where id=$1`, [event.id, event.status, event]);
    }

    // atualizar carteira
    if (event.type === 'payment.succeeded') {
      await credit(event.userRef, event.amount);
    } else if (event.type === 'payout.succeeded') {
      await releaseHold(event.userRef, event.amount, true);
    } else if (event.type === 'payout.failed') {
      await releaseHold(event.userRef, event.amount, false);
    }

    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// Jogo roleta simples
const SERVER_SEED = 'troque-por-semente-segura';

function rng(serverSeed, clientSeed, nonce) {
  const mix = `${serverSeed}:${clientSeed}:${nonce}`;
  const hash = CryptoJS.SHA256(mix).toString();
  return parseInt(hash.slice(0, 8), 16) % 37; // 0-36
}

app.post('/api/games/roulette/bet', async (req, res) => {
  const { userId, amount, betType, betValue, clientSeed = 'web', nonce = `${Date.now()}` } = req.body;
  if (!userId || !amount || amount <= 0) return res.status(400).json({ error: 'parâmetros inválidos' });
  if (!['number', 'color'].includes(betType)) return res.status(400).json({ error: 'tipo inválido' });

  const w = await getWallet(userId);
  if (!w || Number(w.balance) < amount) return res.status(400).json({ error: 'saldo insuficiente' });

  await pool.query('begin');
  await pool.query(`update wallets set balance = balance - $2 where user_id=$1`, [userId, amount]);

  const result = rng(SERVER_SEED, clientSeed, nonce);
  const color = (result === 0) ? 'green' : (result % 2 === 0 ? 'black' : 'red');

  let payout = 0;
  if (betType === 'number' && Number(betValue) === result) payout = amount * 36;
  if (betType === 'color' && betValue === color) payout = amount * 2;

  if (payout > 0) {
    await pool.query(`update wallets set balance = balance + $2 where user_id=$1`, [userId, payout]);
  }

  await pool.query(`insert into rounds (id, user_id, bet_amount, bet_type, bet_value, result, color, payout, server_seed_hash, client_seed, nonce)
                    values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)`,
    [uuidv4(), userId, amount, betType, String(betValue), result, color, payout, CryptoJS.SHA256(SERVER_SEED).toString(), clientSeed, nonce]);
  await pool.query('commit');

  res.json({
    result,
    color,
    win: payout > 0,
    payout,
    serverSeedHash: CryptoJS.SHA256(SERVER_SEED).toString(),
    clientSeed,
    nonce
  });
});

// Inicializa servidor
const port = process.env.PORT || 8080;
app.listen(port, () => console.log(`API on ${port}`));
