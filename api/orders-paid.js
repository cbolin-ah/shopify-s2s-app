const crypto  = require('crypto');
const clients = require('../config/clients');


// ── Collect raw body bytes for HMAC verification ──
// Must use raw bytes — parsing JSON first breaks the signature check
async function getRawBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on('data',  chunk => chunks.push(chunk));
    req.on('end',   ()    => resolve(Buffer.concat(chunks)));
    req.on('error', err   => reject(err));
  });
}


// ── Verify Shopify HMAC signature ──
// Shopify signs every webhook with your app secret.
// Reject anything that doesn’t match — prevents spoofed requests.
function verifyHmac(rawBody, hmacHeader, secret) {
  const digest = crypto
    .createHmac('sha256', secret)
    .update(rawBody)
    .digest('base64');
  try {
    return crypto.timingSafeEqual(
      Buffer.from(digest),
      Buffer.from(hmacHeader)
    );
  } catch {
    return false;
  }
}


// ── SHA-256 hash email ──
// Audiohook requires PII to be hashed before sending.
function hashEmail(email) {
  if (!email) return '';
  return crypto
    .createHash('sha256')
    .update(email.toLowerCase().trim())
    .digest('hex');
}


// ── Send event to Audiohook S2S endpoint ──
async function sendToAudiohook(audiohookId, payload) {
  const url = `https://listen.audiohook.com/${audiohookId}/pixel.png`;
  const res = await fetch(url, {
    method:  'POST',
    headers: { 'Content-Type': 'application/json' },
    body:    JSON.stringify(payload),
  });
  if (!res.ok) {
    throw new Error(`Audiohook responded with status ${res.status}`);
  }
}


// ── Main Vercel serverless handler ──
module.exports = async function handler(req, res) {


  // Only accept POST requests
  if (req.method !== 'POST') {
    return res.status(405).send('Method not allowed');
  }


  // Resolve client slug from URL query string
  // e.g. /api/orders-paid?client=client-acme
  const clientSlug  = req.query.client;
  const audiohookId = clients[clientSlug];


  if (!clientSlug || !audiohookId) {
    console.error(`[audiohook-s2s] unknown client slug: '${clientSlug}'`);
    return res.status(400).send('Unknown client');
  }


  // Read the raw request body
  const rawBody = await getRawBody(req);
  const hmac    = req.headers['x-shopify-hmac-sha256'];
  const secret  = process.env.SHOPIFY_WEBHOOK_SECRET;


  // Reject if HMAC header is missing or secret is not configured
  if (!hmac || !secret) {
    return res.status(401).send('Unauthorized');
  }


  // Reject if signature does not match
  if (!verifyHmac(rawBody, hmac, secret)) {
    return res.status(401).send('Unauthorized');
  }


  // Acknowledge Shopify immediately (must respond within 5 seconds)
  // Processing happens after the response is sent
  res.status(200).send('OK');


  try {
    const order = JSON.parse(rawBody);


    // Route to purchase or repeatpurchase based on customer order history
    // ordersCount of 1 means this is their first completed order
    const ordersCount = order.customer?.orders_count ?? 0;
    const eventName   = ordersCount <= 1 ? 'purchase' : 'repeatpurchase';


    const payload = {
      event_name : eventName,
      timestamp  : new Date(order.created_at).toISOString(),
      order_id   : String(order.id),
      value      : parseFloat(order.total_price),
      currency   : order.currency,
      email      : hashEmail(order.email),
      ip_address : order.browser_ip              || '0.0.0.0',
      user_agent : order.client_details?.user_agent || '',
      url        : `https://${order.source_name || 'yourstore.com'}/checkout`,
    };


    await sendToAudiohook(audiohookId, payload);


    console.log(
      `[audiohook-s2s] ${eventName} tracked`,
      `| client: ${clientSlug}`,
      `| order: ${order.id}`,
      `| value: ${order.total_price} ${order.currency}`,
      `| customer orders: ${ordersCount}`
    );


  } catch (err) {
    // Log the error but do not throw — Shopify has already received 200
    // and retrying would cause duplicate events
    console.error(`[audiohook-s2s] tracking failed | client: ${clientSlug} |`, err.message);
  }
};

