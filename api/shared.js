const crypto = require('crypto');
const { kvGetMerchant } = require('./kv');

async function getRawBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on('data',  chunk => chunks.push(chunk));
    req.on('end',   ()    => resolve(Buffer.concat(chunks)));
    req.on('error', err   => reject(err));
  });
}

// All Shopify webhooks from all stores are signed with the same app-level secret.
function verifyHmac(rawBody, hmacHeader, secret) {
  if (!secret || !hmacHeader) return false;
  const digest = crypto
    .createHmac('sha256', secret)
    .update(rawBody)
    .digest('base64');
  try {
    return crypto.timingSafeEqual(Buffer.from(digest), Buffer.from(hmacHeader));
  } catch {
    return false;
  }
}

function hashEmail(email) {
  if (!email) return '';
  return crypto.createHash('sha256').update(email.toLowerCase().trim()).digest('hex');
}

function getNoteAttr(order, key) {
  if (!Array.isArray(order.note_attributes)) return '';
  const attr = order.note_attributes.find(a => a.name === key);
  return attr?.value || '';
}

async function sendToAudiohook(audiohookId, payload) {
  const url = `https://listen.audiohook.com/${audiohookId}/pixel.png`;
  const res = await fetch(url, {
    method:  'POST',
    headers: { 'Content-Type': 'application/json' },
    body:    JSON.stringify(payload),
  });
  if (!res.ok) throw new Error(`Audiohook responded with status ${res.status}`);
}

// Validates the Shopify HMAC signature and resolves the merchant's audiohookId.
// Returns null and sends an error response if validation fails.
async function validateRequest(req, res) {
  const rawBody = await getRawBody(req);
  const hmac    = req.headers['x-shopify-hmac-sha256'];
  const shop    = req.headers['x-shopify-shop-domain'];
  const secret  = process.env.SHOPIFY_API_SECRET;

  if (!hmac) {
    console.error('[audiohook-s2s] missing HMAC header');
    res.status(401).send('Unauthorized');
    return null;
  }

  if (!verifyHmac(rawBody, hmac, secret)) {
    console.error('[audiohook-s2s] HMAC verification failed');
    res.status(401).send('Unauthorized');
    return null;
  }

  if (!shop) {
    console.error('[audiohook-s2s] missing X-Shopify-Shop-Domain header');
    res.status(400).send('Bad Request');
    return null;
  }

  const merchant = await kvGetMerchant(shop);
  if (!merchant?.audiohookId) {
    console.warn(`[audiohook-s2s] no merchant config found for shop: ${shop}`);
    // Return 200 to prevent Shopify from retrying — this store may have uninstalled
    res.status(200).send('OK');
    return null;
  }

  return { rawBody, shop, audiohookId: merchant.audiohookId };
}

module.exports = { hashEmail, getNoteAttr, sendToAudiohook, validateRequest };
