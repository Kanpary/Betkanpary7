import CryptoJS from 'crypto-js';

export function verifyWebhook(req) {
  const secret = process.env.FXPAY_WEBHOOK_SECRET || '';
  const provided = req.headers['x-fxpay-signature'] || '';
  const payload = JSON.stringify(req.body);
  const calc = CryptoJS.HmacSHA256(payload, secret).toString();
  return provided === calc;
}

export async function createPaymentIntent({ amount, currency, userRef }) {
  const resp = await fetch('https://api.fxpay.com/v1/payments/intents', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${process.env.FXPAY_API_KEY}`
    },
    body: JSON.stringify({
      amount, currency, userRef,
      callbackUrl: `${process.env.PUBLIC_BASE_URL}/api/webhooks/fxpay`
    })
  });
  if (!resp.ok) throw new Error(`FXPay error ${resp.status}`);
  return await resp.json(); // { id, checkoutUrl, ... }
}

export async function createPayout({ amount, currency, userRef, destination }) {
  const resp = await fetch('https://api.fxpay.com/v1/payouts', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${process.env.FXPAY_API_KEY}`
    },
    body: JSON.stringify({
      amount, currency, userRef, destination,
      callbackUrl: `${process.env.PUBLIC_BASE_URL}/api/webhooks/fxpay`
    })
  });
  if (!resp.ok) throw new Error(`FXPay error ${resp.status}`);
  return await resp.json(); // { id, status, ... }
}
