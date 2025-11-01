// bullspay.js

// Criação de pagamento Pix
export async function createPaymentIntent({ amount, currency, userRef }) {
  const resp = await fetch('https://api-gateway.bullspay.com.br/api/transactions/create', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Accept': 'application/json',
      'X-Public-Key': process.env.BULLSPAY_CLIENT_ID,
      'X-Private-Key': process.env.BULLSPAY_API_KEY
    },
    body: JSON.stringify({
      amount, // em centavos (ex: R$ 10,00 = 1000)
      currency: currency || 'BRL',
      external_id: `${userRef}-${Date.now()}`, // evita duplicidade
      payment_method: "pix",
      buyer_infos: {
        buyer_name: "João da Silva", // nome válido
        buyer_email: "joao@example.com", // e-mail válido
        buyer_document: "12345678909", // CPF válido (11 dígitos)
        buyer_phone: "11999999999" // DDD + número, só números
      }
    })
  });

  if (!resp.ok) {
    const errorText = await resp.text();
    throw new Error(`BullsPay error ${resp.status}: ${errorText}`);
  }

  const data = await resp.json();

  return {
    gateway_id: data.data.unic_id,   // <-- renomeado para não conflitar com o id do banco
    status: data.data.status,
    pixCopiaCola: data.data.qr_code_text,
    pixQrCode: `data:image/png;base64,${data.data.qr_code_base64}`,
    checkoutUrl: data.data.payment_url,
    raw: data
  };
}

// Criação de saque (payout)
export async function createPayout({ amount, currency, userRef, destination }) {
  const resp = await fetch('https://api-gateway.bullspay.com.br/api/withdrawals/request', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Accept': 'application/json',
      'X-Public-Key': process.env.BULLSPAY_CLIENT_ID,
      'X-Private-Key': process.env.BULLSPAY_API_KEY
    },
    body: JSON.stringify({
      amount,
      currency: currency || 'BRL',
      external_id: `${userRef}-${Date.now()}`,
      destination,
      callbackUrl: `${process.env.PUBLIC_BASE_URL}/api/webhooks/bullspay`
    })
  });

  if (!resp.ok) {
    const errorText = await resp.text();
    throw new Error(`BullsPay error ${resp.status}: ${errorText}`);
  }

  const data = await resp.json();

  return {
    gateway_id: data.data.unic_id,   // <-- também renomeado
    status: data.data.status,
    raw: data
  };
    }
