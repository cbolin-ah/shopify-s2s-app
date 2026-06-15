// In-memory cache: checkoutToken → { visitorId, sessionId, ts }
// Lives in this function's module scope (persists across warm invocations).
// Both the pixel POST and the checkout extension GET hit this same endpoint,
// so they share the same in-process cache with high probability.
const cache = new Map();
const TTL_MS = 2 * 60 * 60 * 1000; // 2 hours

function cleanup() {
  const now = Date.now();
  for (const [key, val] of cache) {
    if (now - val.ts > TTL_MS) cache.delete(key);
  }
}

module.exports = async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') {
    return res.status(200).end();
  }

  if (req.method === 'POST') {
    let body = req.body;
    if (!body || typeof body !== 'object') {
      try {
        const raw = await new Promise((resolve, reject) => {
          const chunks = [];
          req.on('data', c => chunks.push(c));
          req.on('end', () => resolve(Buffer.concat(chunks).toString()));
          req.on('error', reject);
        });
        body = raw ? JSON.parse(raw) : {};
      } catch {
        body = {};
      }
    }

    const { token, visitorId, sessionId } = body;
    if (!token) return res.status(400).json({ error: 'token required' });

    cleanup();
    cache.set(token, { visitorId: visitorId || '', sessionId: sessionId || '', ts: Date.now() });
    console.log(`[audiohook] checkout-visitor stored: token=${token.slice(0, 8)}... visitorId=${visitorId || 'EMPTY'}`);
    return res.status(200).json({ ok: true });
  }

  if (req.method === 'GET') {
    const { token } = req.query;
    if (!token) return res.status(400).json({ error: 'token required' });
    const entry = cache.get(token);
    if (!entry) {
      return res.status(404).json({ visitorId: null, sessionId: null });
    }
    console.log(`[audiohook] checkout-visitor lookup: token=${token.slice(0, 8)}... visitorId=${entry.visitorId || 'EMPTY'}`);
    return res.status(200).json({ visitorId: entry.visitorId, sessionId: entry.sessionId });
  }

  res.status(405).end();
};
