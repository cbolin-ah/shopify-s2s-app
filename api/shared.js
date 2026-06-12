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
  } catch { return false; }
}

function hashEmail(email) {
  if (!email) return '';
  return crypto
    .createHash('sha256')
    .update(email.toLowerCase().trim())
    .digest('hex');
}

function getNoteAttr(order, key) {
  if (!Array.isArray(order.note_attributes)) return '';
  const attr = order.note_attributes.find(a => a.name === key);
  return attr?.value || '';
}

function getClientSlug(url) {
  const rawQuery = url.includes('?') ? url.split('?')[1] : '';
  return new URLSearchParams(rawQuery).get('client');
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

async function validateRequest(req, res) {
  const clientSlug   = getClientSlug(req.url);
  const clientConfig = clientSlug ? clients[clientSlug] : null;

  if (!clientSlug || !clientConfig) {
    console.error(`[audiohook-s2s] unknown client slug: '${clientSlug}'`);
    res.status(400).send('Unknown client');
    return null;
  }

  const rawBody = await getRawBody(req);
  const hmac    = req.headers['x-shopify-hmac-sha256'];

  if (!hmac) {
    console.error('[audiohook-s2s] missing HMAC header');
    res.status(401).send('Unauthorized');
    return null;
  }

  // Each client has their own webhookSecret in the registry
  if (!verifyHmac(rawBody, hmac, clientConfig.webhookSecret)) {
    console.error('[audiohook-s2s] HMAC verification failed');
    res.status(401).send('Unauthorized');
    return null;
  }

  return {
    rawBody,
    clientSlug,
    audiohookId: clientConfig.audiohookId,
  };
}

module.exports = {
  hashEmail,
  getNoteAttr,
  sendToAudiohook,
  validateRequest,
};
