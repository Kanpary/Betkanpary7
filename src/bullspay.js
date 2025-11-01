// bullspay.js
export async function createPaymentIntent({ amount, currency, userRef }) {
  const resp = await fetch('https://api-gateway.bullspay.com.br/payments/pix', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${process.env.BULLSPAY_API_KEY}`
    },
    body: JSON.stringify({
      amount,
      currency,
      reference: userRef,
      callbackUrl: `${process.env.PUBLIC_BASE_URL}/api/webhooks/bullspay`
    })
  });

  if (!resp.ok) throw new Error(`BullsPay error ${resp.status}`);
  const data = await resp.json();

  return {
    id: data.id,
    status: data.status,
    pixCopiaCola: data.pixCopiaCola,
    pixQrCode: data.pixQrCode
  };
}

export async function createPayout({ amount, currency, userRef, destination }) {
  const resp = await fetch('https://api-gateway.bullspay.com.br/payouts', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${process.env.BULLSPAY_API_KEY}`
    },
    body: JSON.stringify({
      amount,
      currency,
      reference: userRef,
      destination,
      callbackUrl: `${process.env.PUBLIC_BASE_URL}/api/webhooks/bullspay`
    })
  });

  if (!resp.ok) throw new Error(`BullsPay error ${resp.status}`);
  const data = await resp.json();

  return {
    id: data.id,
    status: data.status,
    raw: data
  };
}
