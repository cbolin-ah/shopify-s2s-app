// Upstash Redis REST client (shared with the Shopify Remix app via env vars).
// Requires UPSTASH_REDIS_REST_URL and UPSTASH_REDIS_REST_TOKEN.

function isConfigured() {
  return !!(process.env.UPSTASH_REDIS_REST_URL && process.env.UPSTASH_REDIS_REST_TOKEN);
}

async function upstashFetch(path) {
  if (!isConfigured()) return null;
  try {
    const res = await fetch(`${process.env.UPSTASH_REDIS_REST_URL}${path}`, {
      headers: { Authorization: `Bearer ${process.env.UPSTASH_REDIS_REST_TOKEN}` },
    });
    const data = await res.json();
    return data.result ?? null;
  } catch {
    return null;
  }
}

// ─── Checkout token → visitor ID (short-lived, 2h TTL) ───────────────────────

async function kvSet(key, value, ttlSeconds) {
  const encoded = encodeURIComponent(JSON.stringify(value));
  await upstashFetch(`/set/${encodeURIComponent(key)}/${encoded}?ex=${ttlSeconds}`);
}

async function kvGet(key) {
  const raw = await upstashFetch(`/get/${encodeURIComponent(key)}`);
  if (!raw) return null;
  try { return JSON.parse(decodeURIComponent(raw)); } catch { return null; }
}

// ─── Merchant config (audiohookId keyed by shop domain) ──────────────────────

async function kvGetMerchant(shop) {
  const raw = await upstashFetch(`/get/${encodeURIComponent(`merchant:${shop}`)}`);
  if (!raw) return null;
  try { return JSON.parse(decodeURIComponent(raw)); } catch { return null; }
}

module.exports = { kvSet, kvGet, kvGetMerchant, isConfigured };
