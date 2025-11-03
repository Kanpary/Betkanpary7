// src/bullspay.js
// Adaptador simples para BullsPay (create payment intent + create payout)
//
// Observações:
// - Exige que `fetch` esteja disponível no runtime (Node 18+ tem global fetch).
//   Se estiver em Node mais antigo, instale e polyfill com 'node-fetch'.
// - Usa process.env.BULLSPAY_CLIENT_ID e process.env.BULLSPAY_API_KEY.
// - Usa process.env.BASE_URL para construir o postback_url (fallback para kanparycasino.onrender.com).

/* eslint-disable no-console */
const BASE_URL = (process.env.BASE_URL || 'https://kanparycasino.onrender.com').replace(/\/$/, '');

function ensureEnv() {
  if (!process.env.BULLSPAY_CLIENT_ID || !process.env.BULLSPAY_API_KEY) {
    throw new Error('BULLSPAY_CLIENT_ID e BULLSPAY_API_KEY devem estar configuradas nas envs');
  }
}

/**
 * Normaliza campo possible para extrair qr/copiar-colar/imagem base64 de diferentes formatos
 * @param {object} data resposta do gateway
 */
function extractPixInfo(data = {}) {
  // Possíveis locais onde gateways colocam info de pix (tente vários)
  const pixData = data?.data?.pix_data || data?.pix_data || data?.data?.payment_data?.pix_data || null;

  const qrcode = pixData?.qrcode || data?.data?.payment_data?.qrcode || data?.data?.pix_qrcode || null;
  const qrcodeBase64 = pixData?.qrcode_image_base64 || pixData?.qr_code_base64 || data?.data?.qr_code_base64 || null;
  const copia = pixData?.qrcode || data?.data?.payment_data?.qrcode || data?.data?.pix_data?.qrcode || null;

  return {
    qrcode: qrcode || null,
    qrcodeBase64: qrcodeBase64 || null,
    copiaCola: copia || null
  };
}

/**
 * Cria um payment intent (PIX) na BullsPay (ou gateway compatível)
 * @param {object} opts
 * @param {number} opts.amount em centavos (ex: 1000 = R$10,00) ou em reais (aceitamos reais também)
 * @param {string} [opts.currency='BRL']
 * @param {string} opts.userRef id do usuário (apenas para montar external_id)
 * @param {object} [opts.buyer] dados opcionais do comprador: { buyer_name, buyer_email, buyer_document, buyer_phone }
 */
export async function createPaymentIntent({ amount, currency = 'BRL', userRef, buyer = {} } = {}) {
  ensureEnv();

  if (!amount) throw new Error('Amount é obrigatório');
  // Accept either cents (inteiro) or reais (float). Detecta: se inteiro > 1000 assume centavos, senão multiplica por 100.
  let cents = Number(amount);
  if (!Number.isInteger(cents) || cents <= 0) {
    // Se receber 10.00 (reais) -> transforma em centavos
    cents = Math.round(Number(amount) * 100);
  }
  if (cents <= 0) throw new Error('Amount inválido');

  // Monta postback para o seu servidor — observa que em index.js o webhook é '/webhook/bullspay'
  const postbackUrl = `${BASE_URL}/webhook/bullspay`;

  const payload = {
    amount: cents,
    currency,
    external_id: `${userRef || 'u'}-${Date.now()}`,
    payment_method: 'pix',
    postback_url: postbackUrl,
    buyer_infos: {
      buyer_name: buyer.buyer_name || buyer.name || 'Cliente',
      buyer_email: buyer.buyer_email || buyer.email || 'cliente@example.com',
      buyer_document: buyer.buyer_document || buyer.document || '',
      buyer_phone: buyer.buyer_phone || buyer.phone || ''
    }
  };

  // Em ambientes onde fetch não existe, informe ao usuário
  if (typeof fetch === 'undefined') {
    throw new Error('fetch não disponível no ambiente. Use Node 18+ ou polyfill com node-fetch.');
  }

  const resp = await fetch('https://api-gateway.bullspay.com.br/api/transactions/create', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Accept': 'application/json',
      'X-Public-Key': process.env.BULLSPAY_CLIENT_ID,
      'X-Private-Key': process.env.BULLSPAY_API_KEY
    },
    body: JSON.stringify(payload)
  });

  if (!resp.ok) {
    const errorText = await resp.text().catch(() => 'Não foi possível ler corpo do erro');
    throw new Error(`BullsPay error ${resp.status}: ${errorText}`);
  }

  const data = await resp.json().catch(() => ({}));
  console.log('Resposta BullsPay (deposit):', JSON.stringify(data, null, 2));

  // Extrair info de pix defensivamente
  const pixInfo = extractPixInfo(data);

  // Normalizações defensivas dos campos que podem variar
  const gatewayId =
    data?.data?.payment_data?.id ||
    data?.data?.id ||
    data?.gateway_id ||
    data?.data?.payment_id ||
    null;

  const status = data?.data?.payment_data?.status || data?.data?.status || data?.status || 'pending';

  return {
    gateway_id: gatewayId,
    status,
    pixQrCode: pixInfo.qrcode,               // código Pix (string que pode ser o copia/cola)
    qr_code_base64: pixInfo.qrcodeBase64,    // possível imagem base64 do QR
    pixCopiaCola: pixInfo.copiaCola,
    checkoutUrl: data?.data?.checkoutUrl || data?.checkout_url || null,
    raw: data
  };
}

/**
 * Cria um payout/withdrawal (saque) via BullsPay
 * @param {object} opts
 * @param {number} opts.amount em centavos (ou reais — aceita float)
 * @param {string} [opts.currency='BRL']
 * @param {string} opts.userRef
 * @param {object} opts.destination { type: "cpf"|"cnpj"|"email"|"phone"|"random", key: "..." }
 */
export async function createPayout({ amount, currency = 'BRL', userRef, destination } = {}) {
  ensureEnv();

  if (!amount) throw new Error('Amount é obrigatório');
  if (!destination || !destination.type || !destination.key) throw new Error('Destination inválido');

  let cents = Number(amount);
  if (!Number.isInteger(cents) || cents <= 0) {
    cents = Math.round(Number(amount) * 100);
  }
  if (cents <= 0) throw new Error('Amount inválido');

  const postbackUrl = `${BASE_URL}/webhook/bullspay`; // usa mesmo webhook para simplicidade

  const body = {
    amount: cents,
    currency,
    external_id: `${userRef || 'u'}-${Date.now()}`,
    payment_method: 'pix',
    postback_url: postbackUrl,
    pix_key_type: destination.type,
    pix_key: destination.key
  };

  if (typeof fetch === 'undefined') {
    throw new Error('fetch não disponível no ambiente. Use Node 18+ ou polyfill com node-fetch.');
  }

  const resp = await fetch('https://api-gateway.bullspay.com.br/api/withdrawals/request', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Accept': 'application/json',
      'X-Public-Key': process.env.BULLSPAY_CLIENT_ID,
      'X-Private-Key': process.env.BULLSPAY_API_KEY
    },
    body: JSON.stringify(body)
  });

  if (!resp.ok) {
    const errorText = await resp.text().catch(() => 'Não foi possível ler corpo do erro');
    throw new Error(`BullsPay error ${resp.status}: ${errorText}`);
  }

  const data = await resp.json().catch(() => ({}));
  console.log('Resposta BullsPay (withdrawal):', JSON.stringify(data, null, 2));

  // Extrair id/status defensivamente (vários formatos possíveis)
  const gatewayId =
    data?.data?.withdrawal_id ||
    data?.data?.id ||
    data?.data?.unic_id || // caso errado mas tentar
    data?.gateway_id ||
    null;

  const status = data?.data?.status || data?.status || 'pending';

  return {
    gateway_id: gatewayId,
    status,
    raw: data
  };
    }
      
