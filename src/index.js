// src/index.js
import express from 'express';
import cors from 'cors';
import dotenv from 'dotenv';
import path from 'path';
import { fileURLToPath } from 'url';
import { pool, init } from './db.js';
import { v4 as uuidv4 } from 'uuid';
import { createPaymentIntent, createPayout } from './bullspay.js';

dotenv.config();

const app = express();

// Middlewares
app.use(cors({
  // ATENÇÃO: em produção restrinja o origin em vez de usar '*'
  origin: '*',
  methods: ['GET','POST','PUT','DELETE','OPTIONS'],
  allowedHeaders: ['Content-Type','Authorization']
}));
app.use(express.json({ limit: '1mb' }));
app.use(express.urlencoded({ extended: true }));

// Paths estáticos
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const webDir = path.join(__dirname, '..', 'web');
app.use(express.static(webDir));

// Normalização reais <-> centavos
function toCents(v) {
  const n = Number(v);
  if (Number.isNaN(n) || n <= 0) return 0;
  return Math.round(n * 100);
}
function fromCents(c) {
  return Number(c) / 100;
}

// Validações simples
function validateEmail(email) {
  if (!email || typeof email !== 'string') return false;
  const re = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
  return re.test(email);
}

// Helper: get or create user (retorna userId)
async function getOrCreateUser(email) {
  const id = uuidv4();
  const up = await pool.query(
    `INSERT INTO users (id, email)
     VALUES ($1, $2)
     ON CONFLICT (email) DO UPDATE SET email = EXCLUDED.email
     RETURNING id`,
    [id, email]
  );
  const userId = up.rows[0].id;

  // Garante carteira existente com saldo inicial (exemplo: 500 reais)
  await pool.query(
    `INSERT INTO wallets (user_id, balance, hold)
     VALUES ($1, $2, $3)
     ON CONFLICT (user_id) DO NOTHING`,
    [userId, 50000, 0]
  );

  return userId;
}

// Inicialização
async function main() {
  await init();

  // ===================== Rotas públicas =====================

  // Login
  app.post('/login', async (req, res) => {
    try {
      const { email } = req.body;
      if (!validateEmail(email)) return res.status(400).json({ error: 'E-mail inválido' });

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
      if (!validateEmail(email) || !amount) {
        return res.status(400).json({ error: 'E-mail e amount são obrigatórios e precisam ser válidos' });
      }
      if (Number(amount) < 6) {
        return res.status(400).json({ error: 'O valor mínimo para depósito é R$ 6,00' });
      }

      const userId = await getOrCreateUser(email);

      // Cria intent de pagamento via provider (retorna object com status, pixQrCode, id, etc)
      let paymentData;
      try {
        // Passamos em centavos
        paymentData = await createPaymentIntent({
          amount: toCents(amount),
          currency: currency || 'BRL',
          userRef: userId
        });
      } catch (errProvider) {
        console.error('Erro ao criar payment intent:', errProvider);
        // Em desenvolvimento podemos retornar detalhe: errProvider.message
        return res.status(502).json({ error: 'Erro ao contatar gateway de pagamentos', detail: errProvider.message });
      }

      // Persistir registro do pagamento (manter raw para auditoria)
      try {
        await pool.query(
          `INSERT INTO payments (user_id, amount, currency, type, status, raw)
           VALUES ($1, $2, $3, $4, $5, $6)`,
          [userId, toCents(amount), currency || 'BRL', 'deposit', paymentData.status || 'created', JSON.stringify(paymentData)]
        );
      } catch (errDb) {
        console.error('Erro ao gravar pagamento:', errDb);
        // Não aborta a resposta ao usuário — mas avisa nos logs
      }

      // Normalização dos campos de QR Code / copia e cola
      const qrCodeUrl = paymentData.pixQrCode ?? null;
      const qrCodeBase64 = paymentData.qr_code_base64 ?? null;
      const copiaCola = paymentData.pixCopiaCola || paymentData.qr_code_text || paymentData.pixCopiaECola || null;

      res.json({
        status: paymentData.status || 'pending',
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
    const client = await pool.connect();
    try {
      const { email, amount, currency, destination } = req.body;
      if (!validateEmail(email) || !amount || !destination) {
        client.release();
        return res.status(400).json({ error: 'E-mail, amount e destino são obrigatórios' });
      }

      const userId = await getOrCreateUser(email);
      const cents = toCents(amount);

      await client.query('BEGIN');

      // Seleciona para update para evitar race conditions
      const w = await client.query('SELECT balance FROM wallets WHERE user_id=$1 FOR UPDATE', [userId]);
      if (!w.rows.length) {
        await client.query('ROLLBACK');
        client.release();
        return res.status(404).json({ error: 'Carteira não encontrada' });
      }
      if (Number(w.rows[0].balance) < cents) {
        await client.query('ROLLBACK');
        client.release();
        return res.status(400).json({ error: 'Saldo insuficiente' });
      }

      // Cria o payout com gateway
      let payoutData;
      try {
        payoutData = await createPayout({
          amount: cents,
          currency: currency || 'BRL',
          userRef: userId,
          destination
        });
      } catch (errProvider) {
        await client.query('ROLLBACK');
        client.release();
        console.error('Erro ao criar payout:', errProvider);
        return res.status(502).json({ error: 'Erro ao contatar gateway de pagamentos', detail: errProvider.message });
      }

      // Só debita se gateway retornou algo com status válido (ex.: created/processing)
      if (payoutData && payoutData.status) {
        // deduz balance localmente (registro contábil)
        await client.query('UPDATE wallets SET balance = balance - $1 WHERE user_id = $2', [cents, userId]);

        // registra pagamento / payout
        await client.query(
          `INSERT INTO payments (user_id, amount, currency, type, status, raw)
           VALUES ($1, $2, $3, $4, $5, $6)`,
          [userId, cents, currency || 'BRL', 'payout', payoutData.status, JSON.stringify(payoutData)]
        );
      }

      await client.query('COMMIT');
      client.release();

      res.json(payoutData || { status: 'unknown' });
    } catch (err) {
      await client.query('ROLLBACK').catch(()=>{});
      client.release();
      console.error('Erro no saque:', err);
      res.status(500).json({ error: err.message || 'Erro no saque' });
    }
  });

  // ===================== Jogo: Raspadinha (transacional, single route) =====================
  app.post('/scratch/play', async (req, res) => {
    const client = await pool.connect();
    try {
      const { userId, bet } = req.body;
      if (!userId || !bet) {
        client.release();
        return res.status(400).json({ error: 'Parâmetros obrigatórios: userId e bet' });
      }

      const cents = toCents(bet);
      if (cents < toCents(0.20) || cents > toCents(30)) {
        client.release();
        return res.status(400).json({ error: 'A aposta deve ser entre R$ 0,20 e R$ 30,00' });
      }

      await client.query('BEGIN');

      // bloqueia linha do wallet para evitar race
      const wq = await client.query('SELECT balance FROM wallets WHERE user_id = $1 FOR UPDATE', [userId]);
      if (!wq.rows.length) {
        await client.query('ROLLBACK');
        client.release();
        return res.status(404).json({ error: 'Carteira não encontrada' });
      }
      const balance = Number(wq.rows[0].balance);
      if (balance < cents) {
        await client.query('ROLLBACK');
        client.release();
        return res.status(400).json({ error: 'Saldo insuficiente' });
      }

      // Debita aposta
      await client.query('UPDATE wallets SET balance = balance - $1 WHERE user_id = $2', [cents, userId]);

      // Lógica de prêmio (multipliers)
      const multipliers = [0, 0.5, 1, 2, 5, 10, 20];
      const mult = multipliers[Math.floor(Math.random() * multipliers.length)];
      const prize = Math.round(cents * mult);

      // Credita prêmio se houver
      if (prize > 0) {
        await client.query('UPDATE wallets SET balance = balance + $1 WHERE user_id = $2', [prize, userId]);
      }

      // Registra transação (opcional, para auditoria)
      try {
        await client.query(
          `INSERT INTO payments (user_id, amount, currency, type, status, raw)
           VALUES ($1, $2, $3, $4, $5, $6)`,
          [userId, cents, 'BRL', 'scratch', 'settled', JSON.stringify({ bet: cents, prize })]
        );
      } catch (errReg) {
        console.error('Erro ao registrar pagamento scratch:', errReg);
        // Não abortamos a operação de jogo por falha de log
      }

      const finalBalance = balance - cents + prize;

      await client.query('COMMIT');
      client.release();

      res.json({
        bet: fromCents(cents),
        prize: fromCents(prize),
        finalBalance: fromCents(finalBalance)
      });
    } catch (err) {
      await client.query('ROLLBACK').catch(()=>{});
      client.release();
      console.error('Erro na raspadinha:', err);
      res.status(500).json({ error: 'Erro interno na raspadinha' });
    }
  });

  // ===================== Webhook Bullspay (idempotência corrigida) =====================
  app.post('/webhook/bullspay', async (req, res) => {
    try {
      const payload = req.body;
      console.log('Webhook BullsPay:', JSON.stringify(payload, null, 2));

      // Extrair transaction id / status do payload (ajuste conforme formato real do provider)
      const transactionId = payload?.data?.payment_data?.id || payload?.data?.id || payload?.id;
      const status = payload?.data?.status || payload?.data?.payment_data?.status || payload?.status;

      if (!transactionId) {
        return res.status(400).json({ error: 'Transação inválida: id ausente' });
      }

      // Busca pagamento associado a essa transação (para ler status ANTERIOR)
      const payQ = await pool.query(
        `SELECT id, user_id, amount, status FROM payments
         WHERE (raw->'data'->'payment_data'->>'id' = $1 OR raw->'data'->>'id' = $1) LIMIT 1`,
        [String(transactionId)]
      );

      if (!payQ.rows.length) {
        console.warn('Pagamento não encontrado para transactionId:', transactionId);
        // opcional: salvar um log separado para investigação
        return res.json({ ok: true, note: 'payment_not_found' });
      }

      const paymentRow = payQ.rows[0];
      const paymentId = paymentRow.id;
      const previousStatus = paymentRow.status ? String(paymentRow.status).toLowerCase() : null;

      // Atualiza raw + status
      await pool.query(
        'UPDATE payments SET status = $1, raw = $2 WHERE id = $3',
        [status, JSON.stringify(payload), paymentId]
      );

      // Se status indica pago e ainda não foi creditado, credita carteira
      const newStatus = String(status).toLowerCase();
      if ((newStatus === 'paid' || newStatus === 'confirmed') && previousStatus !== 'paid' && previousStatus !== 'confirmed') {
        // Credita wallet com amount (assumimos amount em centavos)
        if (paymentRow.amount && paymentRow.user_id) {
          try {
            await pool.query(
              'UPDATE wallets SET balance = balance + $1 WHERE user_id = $2',
              [paymentRow.amount, paymentRow.user_id]
            );
            console.log(`💰 Crédito realizado para usuário ${paymentRow.user_id}, valor R$ ${fromCents(paymentRow.amount)}`);
          } catch (errCredit) {
            console.error('Erro ao creditar wallet no webhook:', errCredit);
          }
        } else {
          console.warn('Pagamento sem amount/user_id não credita automaticamente:', paymentId);
        }
      } else {
        console.log(`Webhook recebido para pagamento ${paymentId}: status ${newStatus}, previous ${previousStatus} — sem crédito adicional.`);
      }

      res.json({ ok: true });
    } catch (err) {
      console.error('Erro no webhook:', err);
      res.status(500).json({ error: 'Erro interno' });
    }
  });

  // Health check
  app.get('/health', (req, res) => {
    res.json({ ok: true, ts: new Date().toISOString() });
  });

  // SPA fallback: entrega index.html para rotas não-API
  app.get('*', (req, res, next) => {
    // Se for rota de API, passa para o próximo handler
    const apiPrefixes = ['/login', '/wallet', '/deposit', '/payout', '/scratch', '/webhook', '/health'];
    for (const p of apiPrefixes) {
      if (req.path.startsWith(p)) return next();
    }
    res.sendFile(path.join(webDir, 'index.html'), err => {
      if (err) next(err);
    });
  });

  // Inicialização do servidor
  const PORT = process.env.PORT || 3000;
  app.listen(PORT, () => {
    console.log(`Servidor rodando na porta ${PORT}`);
  });
}

// Executa main
main().catch(err => {
  console.error('Erro ao iniciar aplicação:', err);
  process.exit(1);
});
