// src/bullspay.js
// Adaptador para BullsPay (create payment intent + create payout)
// Requisitos:
// - Node 18+ tem fetch global; em Node <18 este arquivo tentará importar 'node-fetch' dinamicamente.
// - Configure envs: BULLSPAY_CLIENT_ID, BULLSPAY_API_KEY. Opcional: BASE_URL.

const BASE_URL = (process.env.BASE_URL || 'https://kanparycasino.onrender.com').replace(/\/$/, '');

function ensureEnv() {
  if (!process.env.BULLSPAY_CLIENT_ID || !process.env.BULLSPAY_API_KEY) {
    throw new Error('BULLSPAY_CLIENT_ID e BULLSPAY_API_KEY devem estar configuradas nas envs');
  }
}

/** Obtém uma função fetch: usa globalThis.fetch quando disponível, senão tenta importar node-fetch */
async function getFetch() {
  if (typeof fetch !== 'undefined') return fetch;
  try {
    const mod = await import('node-fetch');
    const ff = mod.default ?? mod;
    if (!globalThis.fetch) globalThis.fetch = ff;
    return ff;
  } catch (err) {
    throw new Error('fetch não disponível no ambiente. Use Node 18+ ou instale node-fetch (npm i node-fetch)');
  }
}

/**
 * Normaliza e extrai info de PIX de formatos variados retornados por gateways
 * @param {object} data
 */
function extractPixInfo(data = {}) {
  const pixData =
    data?.data?.pix_data ||
    data?.pix_data ||
    data?.data?.payment_data?.pix_data ||
    data?.data?.payment ||
    null;

  const qrcode =
    pixData?.qrcode ||
    data?.data?.payment_data?.qrcode ||
    data?.data?.pix_qrcode ||
    data?.data?.payment_data?.pix_qr ||
    null;

  const qrcodeBase64 =
    pixData?.qrcode_image_base64 ||
    pixData?.qr_code_base64 ||
    data?.data?.qr_code_base64 ||
    data?.data?.payment_data?.qr_code_base64 ||
    null;

  const copia =
    pixData?.qrcode ||
    data?.data?.payment_data?.qrcode ||
    data?.data?.pix_data?.qrcode ||
    data?.data?.pix_text ||
    null;

  return {
    qrcode: qrcode || null,
    qrcodeBase64: qrcodeBase64 || null,
    copiaCola: copia || null
  };
}

/**
 * Converte input em centavos.
 * Aceita tanto centavos quanto reais. Heurística:
 * - se número inteiro e grande (>1000) pode ser centavos;
 * - caso contrário, multiplica por 100.
 */
function toCentsLocal(v) {
  const n = Number(v);
  if (Number.isNaN(n) || n <= 0) return 0;
  if (Number.isInteger(n) && Math.abs(n) > 1000) return n;
  return Math.round(n * 100);
}

/**
 * Cria um payment intent (PIX) na BullsPay
 * @param {{amount:number|string, currency?:string, userRef?:string, buyer?:object}} opts
 */
export async function createPaymentIntent({ amount, currency = 'BRL', userRef, buyer = {} } = {}) {
  ensureEnv();

  if (!amount) throw new Error('Amount é obrigatório');

  const cents = toCentsLocal(amount);
  if (cents <= 0) throw new Error('Amount inválido');

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

  const fetchFn = await getFetch();

  const resp = await fetchFn('https://api-gateway.bullspay.com.br/api/transactions/create', {
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
    let errorText = '';
    try {
      errorText = await resp.text();
    } catch (e) {
      errorText = '<não foi possível ler corpo do erro>';
    }
    console.error('BullsPay (createPaymentIntent) respondeu não-ok:', resp.status, errorText);
    throw new Error(`BullsPay error ${resp.status}: ${errorText}`);
  }

  const data = await resp.json().catch(() => ({}));
  console.log('Resposta BullsPay (deposit):', JSON.stringify(data, null, 2));

  const pixInfo = extractPixInfo(data);

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
    pixQrCode: pixInfo.qrcode,
    qr_code_base64: pixInfo.qrcodeBase64,
    pixCopiaCola: pixInfo.copiaCola,
    checkoutUrl: data?.data?.checkoutUrl || data?.checkout_url || null,
    raw: data
  };
}

/**
 * Cria um payout/withdrawal (saque) via BullsPay
 * @param {{amount:number|string, currency?:string, userRef?:string, destination:{type:string,key:string}}} opts
 */
export async function createPayout({ amount, currency = 'BRL', userRef, destination } = {}) {
  ensureEnv();

  if (!amount) throw new Error('Amount é obrigatório');
  if (!destination || !destination.type || !destination.key) throw new Error('Destination inválido');

  const cents = toCentsLocal(amount);
  if (cents <= 0) throw new Error('Amount inválido');

  const postbackUrl = `${BASE_URL}/webhook/bullspay`;

  const body = {
    amount: cents,
    currency,
    external_id: `${userRef || 'u'}-${Date.now()}`,
    payment_method: 'pix',
    postback_url: postbackUrl,
    pix_key_type: destination.type,
    pix_key: destination.key
  };

  const fetchFn = await getFetch();

  const resp = await fetchFn('https://api-gateway.bullspay.com.br/api/withdrawals/request', {
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
    let errorText = '';
    try {
      errorText = await resp.text();
    } catch (e) {
      errorText = '<não foi possível ler corpo do erro>';
    }
    console.error('BullsPay (createPayout) respondeu não-ok:', resp.status, errorText);
    throw new Error(`BullsPay error ${resp.status}: ${errorText}`);
  }

  const data = await resp.json().catch(() => ({}));
  console.log('Resposta BullsPay (withdrawal):', JSON.stringify(data, null, 2));

  const gatewayId =
    data?.data?.withdrawal_id ||
    data?.data?.id ||
    data?.data?.unic_id ||
    data?.gateway_id ||
    null;

  const status = data?.data?.status || data?.status || 'pending';

  return {
    gateway_id: gatewayId,
    status,
    raw: data
  };
    }
