// Upstash Redis REST client — replaces Prisma/SQLite for sessions and merchant settings.
// Requires KV_REST_API_URL and KV_REST_API_TOKEN in env.

function isConfigured() {
  return !!(process.env.KV_REST_API_URL && process.env.KV_REST_API_TOKEN);
}

async function upstashFetch(path) {
  if (!isConfigured()) return null;
  try {
    const res = await fetch(`${process.env.KV_REST_API_URL}${path}`, {
      headers: { Authorization: `Bearer ${process.env.KV_REST_API_TOKEN}` },
    });
    const data = await res.json();
    return data.result ?? null;
  } catch {
    return null;
  }
}

async function kvSetRaw(key, value, ttlSeconds) {
  const encoded = encodeURIComponent(JSON.stringify(value));
  const ttl = ttlSeconds ? `?ex=${ttlSeconds}` : '';
  await upstashFetch(`/set/${encodeURIComponent(key)}/${encoded}${ttl}`);
}

async function kvGetRaw(key) {
  const raw = await upstashFetch(`/get/${encodeURIComponent(key)}`);
  if (raw === null || raw === undefined) return null;
  // Upstash may return an already-parsed object when the stored value is valid JSON
  if (typeof raw === 'object') return raw;
  if (typeof raw === 'string') {
    try { return JSON.parse(decodeURIComponent(raw)); } catch {}
    try { return JSON.parse(raw); } catch {}
    return raw;
  }
  return raw;
}

async function kvDel(key) {
  await upstashFetch(`/del/${encodeURIComponent(key)}`);
}

// ─── Shopify Session Storage ──────────────────────────────────────────────────
// Implements the SessionStorage interface required by @shopify/shopify-app-remix.

export const upstashSessionStorage = {
  async storeSession(session) {
    if (!session.accessToken) return true;

    const sessionData = {
      id: session.id,
      shop: session.shop,
      state: session.state,
      isOnline: session.isOnline,
      scope: session.scope,
      accessToken: session.accessToken,
      expires: session.expires instanceof Date ? session.expires.toISOString() : session.expires,
      onlineAccessInfo: session.onlineAccessInfo,
      // Offline sessions under expiringOfflineAccessTokens come with a
      // refresh_token (90-day validity) that Shopify hands back on every
      // token exchange — previously dropped on the floor here, which meant
      // the access token (1h lifetime) had no way to renew itself without a
      // merchant reopening the embedded app. See refreshOfflineToken in
      // sales-snapshot.server.js for where this actually gets used.
      refreshToken: session.refreshToken,
      refreshTokenExpires:
        session.refreshTokenExpires instanceof Date
          ? session.refreshTokenExpires.toISOString()
          : session.refreshTokenExpires,
    };
    Object.keys(sessionData).forEach(k => sessionData[k] === undefined && delete sessionData[k]);

    // TTL has to outlive the refresh token (90 days), not just the short
    // access token (1h) — otherwise the Redis key holding the refresh token
    // would evict itself long before the refresh token was ever used.
    const ttlSource = session.refreshTokenExpires || session.expires;
    const ttl = ttlSource
      ? Math.max(0, Math.floor((new Date(ttlSource) - Date.now()) / 1000))
      : 31536000;
    await kvSetRaw(`session:${session.id}`, sessionData, ttl);
    await kvSetRaw(`shop-session:${session.shop}`, session.id, ttl);
    return true;
  },

  async loadSession(id) {
    const data = await kvGetRaw(`session:${id}`);
    if (!data) return undefined;
    const { Session } = await import("@shopify/shopify-api");
    const session = new Session({
      id: data.id,
      shop: data.shop,
      state: data.state,
      isOnline: data.isOnline,
      scope: data.scope,
      accessToken: data.accessToken,
      onlineAccessInfo: data.onlineAccessInfo,
    });
    if (data.expires) session.expires = new Date(data.expires);
    if (data.refreshToken) session.refreshToken = data.refreshToken;
    if (data.refreshTokenExpires) session.refreshTokenExpires = new Date(data.refreshTokenExpires);
    return session;
  },

  async deleteSession(id) {
    const session = await kvGetRaw(`session:${id}`);
    if (session?.shop) await kvDel(`shop-session:${session.shop}`);
    await kvDel(`session:${id}`);
    return true;
  },

  async deleteSessions(ids) {
    await Promise.all(ids.map(id => this.deleteSession(id)));
    return true;
  },

  async findSessionsByShop(shop) {
    const sessionId = await kvGetRaw(`shop-session:${shop}`);
    if (!sessionId) return [];
    const session = await this.loadSession(String(sessionId));
    return session ? [session] : [];
  },
};

// ─── Merchant Settings ────────────────────────────────────────────────────────
// Keyed by shop domain. Shared with the Vercel S2S app via the same Upstash instance.

export async function getMerchantSettings(shop) {
  return await kvGetRaw(`merchant:${shop}`);
}

export async function upsertMerchantSettings(shop, fields) {
  const existing = (await kvGetRaw(`merchant:${shop}`)) || {};
  const updated = { ...existing, ...fields };
  await kvSetRaw(`merchant:${shop}`, updated, 31536000);
  addActiveShop(shop).catch(() => {});
  return updated;
}

// Called by post-install and settings action
export async function setMerchantConfig(shop, config) {
  await upsertMerchantSettings(shop, config);
}

export async function deleteMerchantConfig(shop) {
  await kvDel(`merchant:${shop}`);
  await removeActiveShop(shop);
}

// ─── Active shop index ──────────────────────────────────────────────────────────
// A Redis set of every shop with a merchant record, so the reconciliation cron
// (api.cron-reconcile.jsx) can enumerate shops to check without scanning the
// whole keyspace. Kept in sync automatically by upsert/delete above.
const ACTIVE_SHOPS_KEY = "shops:active";

async function addActiveShop(shop) {
  await upstashFetch(`/sadd/${encodeURIComponent(ACTIVE_SHOPS_KEY)}/${encodeURIComponent(shop)}`);
}

async function removeActiveShop(shop) {
  await upstashFetch(`/srem/${encodeURIComponent(ACTIVE_SHOPS_KEY)}/${encodeURIComponent(shop)}`);
}

export async function getActiveShops() {
  const result = await upstashFetch(`/smembers/${encodeURIComponent(ACTIVE_SHOPS_KEY)}`);
  return Array.isArray(result) ? result : [];
}

// ─── Checkout → Visitor linkage ────────────────────────────────────────────────
// Bridges the pixel's client-side visitor/session IDs to the server-side
// orders/paid webhook, keyed by checkout token. Needed when note_attributes
// is empty (e.g. Shop Pay / dynamic checkout buttons skip cart attributes).
const CHECKOUT_VISITOR_TTL = 60 * 60 * 2; // 2h — long enough to cover checkout completion

export async function setCheckoutVisitor(token, data) {
  await kvSetRaw(`checkout:${token}`, data, CHECKOUT_VISITOR_TTL);
}

export async function getCheckoutVisitor(token) {
  return await kvGetRaw(`checkout:${token}`);
}

// ─── Customer → purchase history ───────────────────────────────────────────────
// Keyed by Shopify's permanent customer ID (stable across checkout methods,
// unlike orders_count which Shop Pay/accelerated checkouts report unreliably).
// Also doubles as a visitor_id fallback for subscription renewals, where
// note_attributes and the checkout-token KV entry are both long gone.
const CUSTOMER_RECORD_TTL = 60 * 60 * 24 * 365 * 2; // 2 years

export async function getCustomerRecord(customerId) {
  return await kvGetRaw(`customer:${customerId}`);
}

export async function setCustomerRecord(customerId, visitorId, sessionId, hasPurchased = true) {
  await kvSetRaw(`customer:${customerId}`, { visitorId, sessionId, hasPurchased }, CUSTOMER_RECORD_TTL);
}

// ─── Historical sales snapshot ──────────────────────────────────────────────────
// One-time day+region rollup generated when a shop first saves its Audiohook ID.
const SALES_SNAPSHOT_TTL = 60 * 60 * 24 * 365 * 2; // 2 years

export async function setSalesSnapshot(shop, snapshot) {
  await kvSetRaw(`sales-snapshot:${shop}`, snapshot, SALES_SNAPSHOT_TTL);
}

export async function getSalesSnapshot(shop) {
  return await kvGetRaw(`sales-snapshot:${shop}`);
}

// One-time day+channel rollup (6 months) — same trigger as the day/region
// snapshot, but run as its own bulk operation (see webhooks.jsx) rather than
// folded into that query, so a bad field on this side can never break the
// proven region snapshot.
const CHANNEL_SNAPSHOT_TTL = 60 * 60 * 24 * 365 * 2; // 2 years

export async function setChannelSnapshot(shop, snapshot) {
  await kvSetRaw(`channel-snapshot:${shop}`, snapshot, CHANNEL_SNAPSHOT_TTL);
}

export async function getChannelSnapshot(shop) {
  return await kvGetRaw(`channel-snapshot:${shop}`);
}

// ─── Bulk operation sequencing ──────────────────────────────────────────────────
// Shopify only allows one Bulk Operation in flight per shop at a time, so the
// channel snapshot can't be submitted alongside the region snapshot — it's
// submitted from inside BULK_OPERATIONS_FINISH once the region one completes.
// This just remembers which of the two a given completion webhook belongs to.
const BULK_OPERATION_KIND_TTL = 60 * 60; // 1h — comfortably covers one bulk op's runtime

export async function setBulkOperationKind(shop, kind) {
  await kvSetRaw(`bulk-operation-kind:${shop}`, kind, BULK_OPERATION_KIND_TTL);
}

export async function getBulkOperationKind(shop) {
  return await kvGetRaw(`bulk-operation-kind:${shop}`);
}

export async function clearBulkOperationKind(shop) {
  await kvDel(`bulk-operation-kind:${shop}`);
}

// ─── Order dedup ────────────────────────────────────────────────────────────────
// Shopify guarantees at-least-once webhook delivery; avoid double-reporting revenue.
const ORDER_PROCESSED_TTL = 60 * 60 * 24 * 7; // 7 days

export async function wasOrderProcessed(orderId) {
  return !!(await kvGetRaw(`order-sent:${orderId}`));
}

export async function markOrderProcessed(orderId) {
  await kvSetRaw(`order-sent:${orderId}`, true, ORDER_PROCESSED_TTL);
}
