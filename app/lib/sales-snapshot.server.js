// One-time historical sales snapshot (day + region), generated once per shop
// when they first save their Audiohook ID. Uses Bulk Operations since a full
// year of orders can exceed a single request's execution window — the query
// is submitted here, and the result is picked up later by the
// BULK_OPERATIONS_FINISH webhook (see app/routes/webhooks.jsx).

// bulkOperation(id:) came back consistently empty (no error, even after
// retries) when submitted with an online token but queried later with the
// offline token — Shopify likely scopes bulk-op visibility to the
// submitting session. Submit with the offline token too, so the webhook's
// offline admin context can actually see it.
export async function getOfflineAdminClient(shop) {
  const { upstashSessionStorage } = await import("./upstash.server");
  const offlineSession = await upstashSessionStorage.loadSession(`offline_${shop}`);
  if (!offlineSession?.accessToken) return null;

  const apiVersion = "2026-04";
  return {
    graphql: async (query, variablesOrUndefined) => {
      const body = variablesOrUndefined
        ? { query, variables: variablesOrUndefined.variables ?? variablesOrUndefined }
        : { query };
      return fetch(`https://${shop}/admin/api/${apiVersion}/graphql.json`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "X-Shopify-Access-Token": offlineSession.accessToken,
        },
        body: JSON.stringify(body),
      });
    },
  };
}

const BULK_QUERY_MUTATION = `#graphql
  mutation bulkOperationRunQuery($query: String!) {
    bulkOperationRunQuery(query: $query) {
      bulkOperation { id status }
      userErrors { field message }
    }
  }
`;

export async function startSalesSnapshotBulkQuery(admin) {
  // Date-only, unquoted — Shopify's search syntax (created_at:>=2023-01-01)
  // doesn't reliably parse a full ISO timestamp with colons/millis embedded
  // in a quoted value; that silently matched zero orders in testing.
  const since = new Date(Date.now() - 365 * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
  const ordersQuery = `{
    orders(query: "created_at:>=${since}") {
      edges {
        node {
          id
          createdAt
          totalPriceSet { shopMoney { amount currencyCode } }
          shippingAddress { country province }
        }
      }
    }
  }`;

  const res = await admin.graphql(BULK_QUERY_MUTATION, { variables: { query: ordersQuery } });
  const data = await res.json();
  const errs = data?.data?.bulkOperationRunQuery?.userErrors;
  if (errs?.length) throw new Error("bulkOperationRunQuery errors: " + JSON.stringify(errs));
  return data?.data?.bulkOperationRunQuery?.bulkOperation?.id ?? null;
}

// Channel-name field is unverified against a live schema response (no cached
// offline session was available to introspect at write time) — kept in its
// own bulk operation, sequenced after the region snapshot finishes (see
// webhooks.jsx), specifically so a wrong field name here can only fail this
// query, never the proven day/region one sharing the same submission path.
export async function startChannelSnapshotBulkQuery(admin) {
  const since = new Date(Date.now() - 180 * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
  const ordersQuery = `{
    orders(query: "created_at:>=${since}") {
      edges {
        node {
          id
          createdAt
          totalPriceSet { shopMoney { amount currencyCode } }
          channelInformation { channelDefinition { channelName } }
          app { name }
        }
      }
    }
  }`;

  const res = await admin.graphql(BULK_QUERY_MUTATION, { variables: { query: ordersQuery } });
  const data = await res.json();
  const errs = data?.data?.bulkOperationRunQuery?.userErrors;
  if (errs?.length) throw new Error("bulkOperationRunQuery errors: " + JSON.stringify(errs));
  return data?.data?.bulkOperationRunQuery?.bulkOperation?.id ?? null;
}

// currentBulkOperation is deprecated on this API version (confirmed via
// X-Shopify-Api-Deprecated-Reason response header — always returns null).
// bulkOperation(id:) is the correct field, but querying it immediately on
// webhook receipt (~1-3s after completion) also returned null with no error
// — likely a brief backend propagation lag. Retry with backoff.
const GET_BULK_OPERATION = `#graphql
  query getBulkOperation($id: ID!) {
    bulkOperation(id: $id) {
      id
      status
      errorCode
      url
      objectCount
    }
  }
`;

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export async function fetchBulkOperation(admin, bulkOperationGid, { retries = 4, delayMs = 2000 } = {}) {
  for (let attempt = 0; attempt <= retries; attempt++) {
    const res = await admin.graphql(GET_BULK_OPERATION, { variables: { id: bulkOperationGid } });
    const data = await res.json();
    if (data?.errors) {
      throw new Error(`getBulkOperation GraphQL errors: ${JSON.stringify(data.errors)}`);
    }
    const op = data?.data?.bulkOperation ?? null;
    if (op) return op;
    console.warn(`[sales-snapshot] bulkOperation(id:) empty on attempt ${attempt + 1}/${retries + 1}, retrying...`);
    if (attempt < retries) await sleep(delayMs);
  }
  return null;
}

// Bulk query results are JSONL — one order object per line, since
// shippingAddress/totalPriceSet aren't connections and stay inline.
export function aggregateOrdersByDayAndRegion(jsonlText) {
  const buckets = new Map();
  for (const line of jsonlText.split("\n")) {
    if (!line.trim()) continue;
    let order;
    try {
      order = JSON.parse(line);
    } catch {
      continue;
    }
    const date = order.createdAt?.slice(0, 10) || "unknown";
    const country = order.shippingAddress?.country || "Unknown";
    const province = order.shippingAddress?.province || "Unknown";
    const amount = Number(order.totalPriceSet?.shopMoney?.amount ?? 0);
    const currency = order.totalPriceSet?.shopMoney?.currencyCode || "USD";
    const key = `${date}|${country}|${province}`;
    const existing = buckets.get(key);
    if (existing) {
      existing.orders += 1;
      existing.revenue += amount;
    } else {
      buckets.set(key, { date, country, province, orders: 1, revenue: amount, currency });
    }
  }
  return Array.from(buckets.values());
}

// channelDefinition.channelName is the friendly name shown in Shopify's own
// analytics exports ("Online Store", "Point of Sale", a sales-channel app's
// name); app.name is a fallback for orders where channelInformation is null.
export function aggregateOrdersByDayAndChannel(jsonlText) {
  const buckets = new Map();
  for (const line of jsonlText.split("\n")) {
    if (!line.trim()) continue;
    let order;
    try {
      order = JSON.parse(line);
    } catch {
      continue;
    }
    const date = order.createdAt?.slice(0, 10) || "unknown";
    const channel =
      order.channelInformation?.channelDefinition?.channelName ||
      order.app?.name ||
      "Unknown";
    const amount = Number(order.totalPriceSet?.shopMoney?.amount ?? 0);
    const currency = order.totalPriceSet?.shopMoney?.currencyCode || "USD";
    const key = `${date}|${channel}`;
    const existing = buckets.get(key);
    if (existing) {
      existing.orders += 1;
      existing.revenue += amount;
    } else {
      buckets.set(key, { date, channel, orders: 1, revenue: amount, currency });
    }
  }
  return Array.from(buckets.values());
}
