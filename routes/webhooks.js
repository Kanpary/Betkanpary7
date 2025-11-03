// routes/webhooks.js
import express from 'express';
import axios from 'axios';
import { pool } from '../db.js';

const router = express.Router();

router.post('/fxpay', async (req, res) => {
  try {
    // 1. Recebe os dados enviados pelo FXPay
    const { payment_id, transaction_id, user_id } = req.body;
    if (!payment_id && !transaction_id) {
      return res.status(400).json({ error: 'payment_id ou transaction_id é obrigatório' });
    }
    if (!user_id) {
      return res.status(400).json({ error: 'user_id é obrigatório' });
    }

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
    await pool.query(
      `INSERT INTO payments (external_id, type, user_id, amount, currency, status, raw)
       VALUES ($1, $2, $3, $4, $5, $6, $7)
       ON CONFLICT (external_id) DO UPDATE 
       SET status = EXCLUDED.status, raw = EXCLUDED.raw`,
      [
        payment_id || transaction_id,
        'payment',
        user_id,
        data.amount, // ⚠️ certifique-se se vem em centavos ou reais
        data.currency || 'BRL',
        data.status,
        JSON.stringify(data)
      ]
    );

    // 4. Se aprovado, credita na carteira (idempotência simples)
    if (data.status === 'approved' || data.status === 'paid') {
      const check = await pool.query(
        'SELECT status FROM payments WHERE external_id = $1',
        [payment_id || transaction_id]
      );
      const currentStatus = check.rows[0]?.status;
      if (currentStatus && currentStatus.toLowerCase() === data.status.toLowerCase()) {
        // já está aprovado/pago, não credita de novo
        console.log(`Webhook FXPay ignorado: pagamento ${payment_id || transaction_id} já está ${currentStatus}`);
      } else {
        await pool.query(
          'UPDATE wallets SET balance = balance + $1 WHERE user_id = $2',
          [data.amount, user_id]
        );
        console.log(`💰 Crédito realizado para usuário ${user_id}, valor ${data.amount}`);
      }
    }

    // 5. Sempre responde 200 para o FXPay não reenviar
    res.status(200).json({ ok: true });
  } catch (err) {
    console.error('Erro no webhook FXPay:', err.message);
    // Mesmo em erro, respondemos 200 para evitar reenvio em loop
    res.status(200).json({ received: true });
  }
});

export default router;
