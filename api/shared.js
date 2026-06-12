const crypto  = require('crypto');
const clients = require('../config/clients');

// Collect raw body bytes — must be raw for HMAC verification
async function getRawBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on('data',  chunk => chunks.push(chunk));
    req.on('end',   ()    => resolve(Buffer.concat(chunks)));
    req.on('error', err   => reject(err));
  });
}

// Verify Shopify HMAC signature
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
  } catch { return false; }
}

// SHA-256 hash email per Audiohook PII requirements
function hashEmail(email) {
  if (!email) return '';
  return crypto
    .createHash('sha256')
    .update(email.toLowerCase().trim())
    .digest('hex');
}

// Read a note attribute value from order.note_attributes array
// This is how visitor_id and session_id travel from browser to server
function getNoteAttr(order, key) {
  if (!Array.isArray(order.note_attributes)) return '';
  const attr = order.note_attributes.find(a => a.name === key);
  return attr?.value || '';
}

// Parse client slug from URL query string
function getClientSlug(url) {
  const rawQuery = url.includes('?') ? url.split('?')[1] : '';
  return new URLSearchParams(rawQuery).get('client');
}

// Send event to Audiohook S2S endpoint
async function sendToAudiohook(audiohookId, payload) {
  const url = `https://listen.audiohook.com/${audiohookId}/pixel.png`;
  const res = await fetch(url, {
    method:  'POST',
    headers: { 'Content-Type': 'application/json' },
    body:    JSON.stringify(payload),
  });
  if (!res.ok) throw new Error(`Audiohook responded with status ${res.status}`);
}

// Validate incoming Shopify webhook request
// Handles client slug lookup and HMAC verification
// Returns context object or null (and sends error response) if invalid
async function validateRequest(req, res) {
  const clientSlug  = getClientSlug(req.url);
  const audiohookId = clientSlug ? clients[clientSlug] : null;

  if (!clientSlug || !audiohookId) {
    console.error(`[audiohook-s2s] unknown client slug: '${clientSlug}'`);
    res.status(400).send('Unknown client');
    return null;
  }

  const rawBody = await getRawBody(req);
  const hmac    = req.headers['x-shopify-hmac-sha256'];
  const secret  = process.env.SHOPIFY_WEBHOOK_SECRET;

  if (!hmac || !secret) {
    console.error('[audiohook-s2s] missing HMAC header or webhook secret');
    res.status(401).send('Unauthorized');
    return null;
  }

  if (!verifyHmac(rawBody, hmac, secret)) {
    console.error('[audiohook-s2s] HMAC verification failed');
    res.status(401).send('Unauthorized');
    return null;
  }

  return { rawBody, clientSlug, audiohookId };
}

module.exports = {
  hashEmail,
  getNoteAttr,
  sendToAudiohook,
  validateRequest,
};
