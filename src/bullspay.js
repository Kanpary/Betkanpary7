// bullspay.js

// Criação de pagamento Pix (depósito)
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
      postback_url: `${process.env.BASE_URL || 'https://kanparycasino.onrender.com'}/api/webhooks/bullspay`,
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
  console.log("Resposta BullsPay (deposit):", JSON.stringify(data, null, 2));

  // Normaliza os campos para o front
  return {
    gateway_id: data.data?.payment_data?.id || null,
    status: data.data?.payment_data?.status || 'pending',
    // A BullsPay não retorna imagem de QR, apenas o código Pix
    pixQrCode: null,
    qr_code_base64: null,
    // Pix Copia e Cola vem em data.pix_data.qrcode
    pixCopiaCola: data.data?.pix_data?.qrcode || null,
    checkoutUrl: null,
    raw: data
  };
}

// Criação de saque (withdrawal)
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
      amount, // em centavos
      currency: currency || 'BRL',
      external_id: `${userRef}-${Date.now()}`,
      payment_method: "pix",
      postback_url: `${process.env.BASE_URL || 'https://kanparycasino.onrender.com'}/api/webhooks/bullspay/payout`,
      // destination deve conter { type: "cpf"|"cnpj"|"email"|"phone"|"random", key: "..." }
      pix_key_type: destination.type,
      pix_key: destination.key
    })
  });

  if (!resp.ok) {
    const errorText = await resp.text();
    throw new Error(`BullsPay error ${resp.status}: ${errorText}`);
  }

  const data = await resp.json();

  console.log("Resposta BullsPay (withdrawal):", JSON.stringify(data, null, 2));

  return {
    gateway_id: data.data?.unic_id || null,
    status: data.data?.status || 'pending',
    raw: data
  };
}
