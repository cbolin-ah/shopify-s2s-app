// Stores checkout_token → { visitorId, sessionId } in Vercel KV (Redis).
// Called by the web pixel on checkout_started — bridges visitor identity from
// the browser session to the server-side orders/paid webhook.
//
// Requires Vercel KV to be linked to this project (see api/kv.js for setup).

const { kvSet, kvGet, isConfigured } = require('./kv');

const TTL_SECONDS = 2 * 60 * 60; // 2 hours

module.exports.config = { api: { bodyParser: true } };

module.exports = async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') return res.status(200).end();

  if (req.method === 'POST') {
    const { token, visitorId, sessionId } = req.body || {};
    if (!token) return res.status(400).json({ error: 'token required' });
    if (!visitorId) return res.status(400).json({ error: 'visitorId required' });

    await kvSet(`checkout:${token}`, { visitorId, sessionId: sessionId || '' }, TTL_SECONDS);
    console.log(`[audiohook] checkout-visitor stored: token=${token.slice(0, 8)}... visitor=${visitorId.slice(0, 8)}... kv=${isConfigured()}`);
    return res.status(200).json({ ok: true });
  }

  if (req.method === 'GET') {
    const { token } = req.query;
    if (!token) return res.status(400).json({ error: 'token required' });
    const entry = await kvGet(`checkout:${token}`);
    if (!entry) return res.status(404).json({ visitorId: null, sessionId: null });
    return res.status(200).json(entry);
  }

  res.status(405).end();
};
