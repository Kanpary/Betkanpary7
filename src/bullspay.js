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

  // Log para debug (veja no Render)
  console.log("Resposta BullsPay:", JSON.stringify(data, null, 2));

  // Normaliza os campos para o front
  return {
    gateway_id: data.data?.unic_id || null,
    status: data.data?.status || 'pending',
    // QR Code pode vir como URL ou base64
    pixQrCode: data.data?.pixQrCode || data.data?.qr_code_url || null,
    qr_code_base64: data.data?.qr_code_base64 || data.data?.qrCodeBase64 || null,
    // Pix Copia e Cola pode vir com nomes diferentes
    pixCopiaCola: data.data?.pixCopiaCola
               || data.data?.qr_code_text
               || data.data?.pixCopiaECola
               || data.data?.pix_code
               || data.data?.payload
               || data.data?.emv
               || null,
    checkoutUrl: data.data?.checkoutUrl || data.data?.url || null,
    raw: data
  };
}

// Criação de saque (payout)
export async function createPayout({ amount, currency, userRef, destination }) {
  const resp = await fetch('https://api-gateway.bullspay.com.br/api/transactions/payout', {
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
      payment_method: "pix",
      destination
    })
  });

  if (!resp.ok) {
    const errorText = await resp.text();
    throw new Error(`BullsPay error ${resp.status}: ${errorText}`);
  }

  const data = await resp.json();

  console.log("Resposta BullsPay (payout):", JSON.stringify(data, null, 2));

  return {
    gateway_id: data.data?.unic_id || null,
    status: data.data?.status || 'pending',
    raw: data
  };
}
