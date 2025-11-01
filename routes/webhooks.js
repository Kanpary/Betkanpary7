// routes/webhooks.js
import express from 'express';
import axios from 'axios';
import { pool } from '../db.js';

const router = express.Router();

router.post('/fxpay', async (req, res) => {
  try {
    // 1. Recebe os dados enviados pelo FXPay
    const { payment_id, transaction_id, user_id } = req.body;

    // 2. Consulta a API do FXPay para validar
    const resp = await axios.get('https://api.fxpay.com/v1/payments/status', {
      params: {
        id: payment_id || transaction_id,
        client_id: process.env.FXPAY_CLIENT_ID
      },
      headers: {
        Authorization: `Bearer ${process.env.FXPAY_API_KEY}`
      }
    });

    const data = resp.data;

    // 3. Salva/atualiza o pagamento no banco
    // ⚠️ Não passamos mais "id" manualmente, deixamos o Postgres gerar
    await pool.query(
      `INSERT INTO payments (type, user_id, amount, currency, status, raw)
       VALUES ($1, $2, $3, $4, $5, $6)
       ON CONFLICT (user_id, raw) DO UPDATE 
       SET status = EXCLUDED.status, raw = EXCLUDED.raw`,
      ['payment', user_id, data.amount, data.currency, data.status, data]
    );

    // 4. Se aprovado, credita na carteira
    if (data.status === 'approved' || data.status === 'paid') {
      await pool.query(
        'UPDATE wallets SET balance = balance + $1 WHERE user_id = $2',
        [data.amount, user_id]
      );
    }

    // 5. Sempre responde 200 para o FXPay não reenviar
    res.status(200).json({ ok: true });
  } catch (err) {
    console.error('Erro no webhook FXPay:', err.message);
    res.status(200).json({ received: true });
  }
});

export default router;
