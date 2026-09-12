// Shared order → Audiohook forwarding logic. Used by both the real-time
// orders/paid webhook (api.orders-paid.jsx) and the reconciliation cron
// (api.cron-reconcile.jsx), so an order recovered by reconciliation gets
// identical attribution/classification/purchase_type treatment to one that
// arrived on time — no separate, drifting copy of this logic.

const AUDIOHOOK_INGEST_URL = (audiohookId) =>
  `https://listen.audiohook.com/${audiohookId}/pixel.png`;

// Order/customer ids arrive as plain numeric strings from the REST webhook
// payload, but as GraphQL GIDs (gid://shopify/Order/123) from the
// reconciliation cron's Admin GraphQL query — normalize both to the same
// trailing-numeric form so dedupe/customer-history keys always collide
// correctly regardless of source.
function normalizeId(id) {
  return id == null ? null : String(id).split("/").pop();
}

export async function processOrder(shop, order, { source = "webhook" } = {}) {
  const {
    getMerchantSettings,
    upsertMerchantSettings,
    getCheckoutVisitor,
    getCustomerRecord,
    setCustomerRecord,
    wasOrderProcessed,
    markOrderProcessed,
  } = await import("./upstash.server");

  const orderId = normalizeId(order.id);
  const customerId = normalizeId(order.customer?.id);

  if (await wasOrderProcessed(orderId)) {
    return { orderId, forwarded: false, skipped: "already-processed" };
  }

  const settings = await getMerchantSettings(shop);
  const audiohookId = settings?.audiohookId;
  if (!audiohookId) {
    console.warn(`[order-processing:${source}] no audiohookId configured for ${shop}, dropping order ${orderId}`);
    return { orderId, forwarded: false, skipped: "no-audiohook-id" };
  }

  const noteAttrs = Array.isArray(order.note_attributes) ? order.note_attributes : [];
  const getNote = (name) => noteAttrs.find((a) => a.name === name)?.value || null;

  // Primary: cart attributes → note_attributes (set by theme extension).
  let visitorId = getNote("ah_visitor_id");
  let sessionId = getNote("ah_session_id");

  // Fallback: pixel's checkout_started KV entry, for checkouts that skip cart
  // attributes entirely (Shop Pay, dynamic checkout buttons).
  if (!visitorId && order.checkout_token) {
    const linked = await getCheckoutVisitor(order.checkout_token);
    if (linked?.visitorId) {
      visitorId = linked.visitorId;
      sessionId = linked.sessionId || "";
    }
  }

  // Subscription-renewal fallback: last known visitor_id for this customer,
  // for recurring orders where note_attributes and the checkout-token KV
  // entry are both long gone.
  let customerData = null;
  if (customerId) {
    customerData = await getCustomerRecord(customerId);
    if (!visitorId && customerData?.visitorId) {
      visitorId = customerData.visitorId;
      sessionId = customerData.sessionId || "";
    }
  }

  // Our own purchase history, not Shopify's orders_count — Shop Pay and
  // accelerated checkouts report orders_count unreliably (often 0 or 1
  // regardless of actual history).
  const isRepeat = !!customerData?.hasPurchased;
  const eventName = isRepeat ? "repeatpurchase" : "purchase";

  if (customerId) {
    setCustomerRecord(
      customerId,
      visitorId || customerData?.visitorId || "",
      sessionId || customerData?.sessionId || "",
      true
    ).catch(() => {});
  }

  const items = Array.isArray(order.line_items)
    ? order.line_items.map((li) => ({
        product_id: String(li.product_id ?? ""),
        product_name: li.title ?? "",
        price: Number(li.price ?? 0),
        quantity: li.quantity ?? 1,
      }))
    : [];

  const timestamp = new Date(order.created_at || Date.now()).toISOString();

  // Wallet (apple_pay/google_pay/etc) beats raw gateway name — Shopify Payments
  // card charges routed through a wallet still list "shopify_payments" as the
  // gateway, so credit_card_wallet is the only field that reveals the wallet.
  // Not available via the reconciliation cron's GraphQL query (unconfirmed
  // field, left out rather than risking the whole query) — those orders fall
  // back to gateway name only.
  const paymentGateways = Array.isArray(order.payment_gateway_names) ? order.payment_gateway_names : [];
  const purchaseType = order.payment_details?.credit_card_wallet || paymentGateways[0] || "unknown";

  const payload = {
    name: eventName,
    event_name: eventName,
    timestamp,
    event_timestamp: timestamp,
    visitor_id: visitorId || "",
    session_id: sessionId || "",
    url: `https://${shop}/checkout/success`,
    referrer: order.landing_site || "",
    user_agent: order.client_details?.user_agent || "",
    ip_address: order.browser_ip || order.client_details?.browser_ip || "0.0.0.0",
    order_id: orderId,
    value: Number(order.total_price ?? 0),
    currency: order.currency || "USD",
    purchase_type: purchaseType,
    items,
    source,
  };

  console.log(`[order-processing:${source}] payload: ${JSON.stringify(payload)}`);

  try {
    const res = await fetch(AUDIOHOOK_INGEST_URL(audiohookId), {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });
    if (!res.ok) {
      const text = await res.text().catch(() => "");
      console.error(`[order-processing:${source}] order ${orderId}: Audiohook API error ${res.status}: ${text}`);
      upsertMerchantSettings(shop, {
        lastEventAt: new Date().toISOString(),
        lastEventStatus: "error",
        lastError: `Audiohook API error ${res.status}: ${text.slice(0, 300)}`,
      }).catch(() => {});
    } else {
      upsertMerchantSettings(shop, {
        lastEventAt: new Date().toISOString(),
        lastEventStatus: "ok",
      }).catch(() => {});
    }
    // Mark processed regardless of Audiohook's response status — a rejected
    // payload will be rejected identically on redelivery, so there's nothing
    // a retry would fix. The error above is what needs a real fix.
    await markOrderProcessed(orderId);
    return { orderId, forwarded: res.ok, eventName, status: res.status };
  } catch (err) {
    console.error(`[order-processing:${source}] order ${orderId}: failed to forward to Audiohook:`, err.message);
    upsertMerchantSettings(shop, {
      lastEventAt: new Date().toISOString(),
      lastEventStatus: "error",
      lastError: `Network error: ${err.message}`,
    }).catch(() => {});
    // Not marked processed — the webhook route turns this into a 500 so
    // Shopify retries; the reconcile cron just picks it up again next run.
    return { orderId, forwarded: false, error: err.message };
  }
}
