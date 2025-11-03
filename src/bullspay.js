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
  // tenta importar node-fetch dinamicamente
  try {
    const mod = await import('node-fetch');
    const ff = mod.default ?? mod;
    // define global para chamadas futuras
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
  if (Number.isNaN(n) || n <= 0
