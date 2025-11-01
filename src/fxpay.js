// fxpay.js
import CryptoJS from 'crypto-js';

// Verifica a assinatura do webhook (se o FXPay enviar header x-fxpay-signature).
// Caso o FXPay não envie assinatura, aceitamos e validamos depois via API.
export function verifyWebhook(req) {
  const provided = req.headers['x-fxpay-signature'] || '';
  if (!provided) {
    // Sem assinatura → aceita provisoriamente
    return true;
  }

  const secret = process.env.FXPAY_API_KEY; // use a Secret Key
  const payload = JSON.stringify(req.body);
  const calc = CryptoJS.HmacSHA256(payload, secret).toString();
  return provided === calc;
}

// Cria uma intenção de pagamento (depósito via Pix)
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
  const data = await resp.json();

  // Retorna os campos importantes para o frontend
  return {
    id: data.id,
    status: data.status,
    checkoutUrl: data.checkoutUrl,
    pixCopiaCola: data.pixCopiaCola,
    pixQrCode: data.pixQrCode
  };
}

// Cria uma solicitação de saque (payout)
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
  const data = await resp.json();

  return {
    id: data.id,
    status: data.status,
    raw: data
  };
}
