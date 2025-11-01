// bullspay.js

// Criação de pagamento Pix
export async function createPaymentIntent({ amount, currency, userRef }) {
  const resp = await fetch('https://api-gateway.bullspay.com.br/api/transactions/create', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Accept': 'application/json',
      'X-Public-Key': process.env.BULLSPAY_PUBLIC_KEY,
      'X-Private-Key': process.env.BULLSPAY_PRIVATE_KEY
    },
    body: JSON.stringify({
      amount, // em centavos (ex: R$ 10,00 = 1000)
      external_id: userRef,
      payment_method: "pix",
      buyer_infos: {
        buyer_name: "Usuário",
        buyer_email: "teste@example.com",
        buyer_document: "00000000000",
        buyer_phone: "11999999999"
      },
      callbackUrl: `${process.env.PUBLIC_BASE_URL}/api/webhooks/bullspay`
    })
  });

  if (!resp.ok) throw new Error(`BullsPay error ${resp.status}`);
  const data = await resp.json();

  return {
    id: data.data.unic_id,
    status: data.data.status,
    pixCopiaCola: data.data.qr_code_text,
    pixQrCode: `data:image/png;base64,${data.data.qr_code_base64}`,
    checkoutUrl: data.data.payment_url
  };
}

// Criação de saque (payout)
export async function createPayout({ amount, currency, userRef, destination }) {
  const resp = await fetch('https://api-gateway.bullspay.com.br/api/withdrawals/request', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Accept': 'application/json',
      'X-Public-Key': process.env.BULLSPAY_PUBLIC_KEY,
      'X-Private-Key': process.env.BULLSPAY_PRIVATE_KEY
    },
    body: JSON.stringify({
      amount,
      external_id: userRef,
      currency,
      destination,
      callbackUrl: `${process.env.PUBLIC_BASE_URL}/api/webhooks/bullspay`
    })
  });

  if (!resp.ok) throw new Error(`BullsPay error ${resp.status}`);
  const data = await resp.json();

  return {
    id: data.data.unic_id,
    status: data.data.status,
    raw: data
  };
}
