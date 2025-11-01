// fxpay.js
import CryptoJS from 'crypto-js';

// Verifica a assinatura do webhook (se o FXPay enviar header x-fxpay-signature).
// Caso o FXPay não envie assinatura, você pode simplesmente retornar true
// e validar a transação consultando a API com client_id + secret.
export function verifyWebhook(req) {
  const provided = req.headers['x-fxpay-signature'] || '';
  if (!provided) {
    // Sem assinatura → aceita provisoriamente, valida depois via API
    return true;
  }

  const secret = process.env.FXPAY_API_KEY; // use a Secret Key
  const payload = JSON.stringify(req.body);
  const calc = CryptoJS.HmacSHA256(payload, secret).toString();
  return provided === calc;
}

// Cria uma intenção de pagamento (depósito)
export async function createPaymentIntent({ amount, currency, userRef }) {
  const resp = await fetch('https://api.fxpay.com/v1/payments/intents', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${process.env.FXPAY_API_KEY}`
    },
    body: JSON.stringify({
      amount,
      currency,
      userRef,
      // alguns docs usam "urlnoty" em vez de "callbackUrl"
      urlnoty: `${process.env.PUBLIC_BASE_URL}/api/webhooks/fxpay`
    })
  });

  if (!resp.ok) throw new Error(`FXPay error ${resp.status}`);
  return await resp.json(); // esperado: { id, checkoutUrl, status, ... }
}

// Cria um payout (saque)
export async function createPayout({ amount, currency, userRef, destination }) {
  const resp = await fetch('https://api.fxpay.com/v1/payouts', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${process.env.FXPAY_API_KEY}`
    },
    body: JSON.stringify({
      amount,
      currency,
      userRef,
      destination,
      urlnoty: `${process.env.PUBLIC_BASE_URL}/api/webhooks/fxpay`
    })
  });

  if (!resp.ok) throw new Error(`FXPay error ${resp.status}`);
  return await resp.json(); // esperado: { id, status, ... }
}

// Consulta status de um pagamento
export async function fetchPaymentStatus(id) {
  const resp = await fetch(`https://api.fxpay.com/v1/payments/status?id=${id}&client_id=${process.env.FXPAY_CLIENT_ID}`, {
    headers: {
      'Authorization': `Bearer ${process.env.FXPAY_API_KEY}`
    }
  });
  if (!resp.ok) throw new Error(`FXPay status error ${resp.status}`);
  return await resp.json();
}

// Consulta status de um payout
export async function fetchPayoutStatus(id) {
  const resp = await fetch(`https://api.fxpay.com/v1/payouts/status?id=${id}&client_id=${process.env.FXPAY_CLIENT_ID}`, {
    headers: {
      'Authorization': `Bearer ${process.env.FXPAY_API_KEY}`
    }
  });
  if (!resp.ok) throw new Error(`FXPay payout status error ${resp.status}`);
  return await resp.json();
}
