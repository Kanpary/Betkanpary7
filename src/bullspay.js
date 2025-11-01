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
      amount, // em centavos
      currency,
      external_id: userRef,
      payment_method: "pix",
      buyer_infos: {
        buyer_name: "Usuário Teste",
        buyer_email: "teste@example.com",
        buyer_document: "00000000000",
        buyer_phone: "11999999999"
      }
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
