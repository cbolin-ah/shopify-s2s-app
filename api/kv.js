// Thin wrapper over Vercel KV REST API (https://vercel.com/docs/storage/vercel-kv/rest-api).
// Vercel KV is Upstash Redis under the hood — same REST protocol.
//
// Setup: vercel.com → project → Storage → Create KV Database → link project.
// Vercel auto-injects KV_REST_API_URL and KV_REST_API_TOKEN as env vars.
//
// If those vars are absent (local dev or KV not yet provisioned), all ops are
// no-ops so the app still works — just without the checkout-token fallback path.

function isConfigured() {
  return !!(process.env.UPSTASH_REDIS_REST_URL && process.env.UPSTASH_REDIS_REST_TOKEN);
}

async function kvSet(key, value, ttlSeconds) {
  if (!isConfigured()) return;
  const encoded = encodeURIComponent(JSON.stringify(value));
  await fetch(
    `${process.env.UPSTASH_REDIS_REST_URL}/set/${encodeURIComponent(key)}/${encoded}?ex=${ttlSeconds}`,
    { headers: { Authorization: `Bearer ${process.env.UPSTASH_REDIS_REST_TOKEN}` } }
  ).catch(() => {});
}

async function kvGet(key) {
  if (!isConfigured()) return null;
  try {
    const res = await fetch(
      `${process.env.UPSTASH_REDIS_REST_URL}/get/${encodeURIComponent(key)}`,
      { headers: { Authorization: `Bearer ${process.env.UPSTASH_REDIS_REST_TOKEN}` } }
    );
    const data = await res.json();
    return data.result ? JSON.parse(decodeURIComponent(data.result)) : null;
  } catch {
    return null;
  }
}

module.exports = { kvSet, kvGet, isConfigured };
