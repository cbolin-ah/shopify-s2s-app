const crypto  = require('crypto');
const clients = require('../config/clients');

async function getRawBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on('data',  chunk => chunks.push(chunk));
    req.on('end',   ()    => resolve(Buffer.concat(chunks)));
    req.on('error', err   => reject(err));
  });
}

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

function hashEmail(email) {
  if (!email) return '';
  return crypto
    .createHash('sha256')
    .update(email.toLowerCase().trim())
    .digest('hex');
}

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

module.exports = async function handler(req, res) {
  console.log('[audiohook-s2s] function invoked', req.method, req.url);

  if (req.method !== 'POST') {
    return res.status(405).send('Method not allowed');
  }

  // Parse client slug directly from query string — no URL constructor needed
  const rawQuery   = req.url.includes('?') ? req.url.split('?')[1] : '';
  const params     = new URLSearchParams(rawQuery);
  const clientSlug = params.get('client');
  const audiohookId = clients[clientSlug];

  console.log('[audiohook-s2s] client slug:', clientSlug, '| audiohookId:', audiohookId ? 'found' : 'NOT FOUND');

  if (!clientSlug || !audiohookId) {
    console.error(`[audiohook-s2s] unknown client slug: '${clientSlug}'`);
    return res.status(400).send('Unknown client');
  }

  const rawBody = await getRawBody(req);
  const hmac    = req.headers['x-shopify-hmac-sha256'];
  const secret  = process.env.SHOPIFY_WEBHOOK_SECRET;

  console.log('[audiohook-s2s] hmac present:', !!hmac, '| secret present:', !!secret);

  if (!hmac || !secret) {
    console.error('[audiohook-s2s] missing HMAC header or webhook secret');
    return res.status(401).send('Unauthorized');
  }

  if (!verifyHmac(rawBody, hmac, secret)) {
    console.error('[audiohook-s2s] HMAC verification failed');
    return res.status(401).send('Unauthorized');
  }

  res.status(200).send('OK');

  try {
    const order       = JSON.parse(rawBody);
    const ordersCount = order.customer?.orders_count ?? 0;
    const eventName   = ordersCount <= 1 ? 'purchase' : 'repeatpurchase';

    const payload = {
      event_name : eventName,
      timestamp  : new Date(order.created_at).toISOString(),
      order_id   : String(order.id),
      value      : parseFloat(order.total_price),
      currency   : order.currency,
      email      : hashEmail(order.email),
      ip_address : order.browser_ip               || '0.0.0.0',
      user_agent : order.client_details?.user_agent || '',
      url        : `https://${order.source_name || 'yourstore.com'}/checkout`,
    };

    await sendToAudiohook(audiohookId, payload);

    console.log(
      `[audiohook-s2s] ${eventName} tracked`,
      `| client: ${clientSlug}`,
      `| order: ${order.id}`,
      `| value: ${order.total_price} ${order.currency}`
    );

  } catch (err) {
    console.error(`[audiohook-s2s] tracking failed | client: ${clientSlug} |`, err.message);
  }
};
