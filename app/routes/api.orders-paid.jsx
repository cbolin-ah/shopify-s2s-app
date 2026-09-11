import crypto from "node:crypto";

const AUDIOHOOK_INGEST_URL = (audiohookId) =>
  `https://listen.audiohook.com/${audiohookId}/pixel.png`;

// This webhook is registered via webhookSubscriptionCreate against a custom
// URL (not the app's toml-managed /webhooks endpoint), so it doesn't go
// through authenticate.webhook() — HMAC verification has to happen by hand.
function verifyShopifyHmac(rawBody, hmacHeader) {
  if (!hmacHeader) return false;
  const secret = process.env.SHOPIFY_API_SECRET;
  const digest = crypto.createHmac("sha256", secret).update(rawBody, "utf8").digest("base64");
  const expected = Buffer.from(digest);
  const received = Buffer.from(hmacHeader);
  return expected.length === received.length && crypto.timingSafeEqual(expected, received);
}

export async function action({ request }) {
  const rawBody = await request.text();
  const hmacHeader = request.headers.get("X-Shopify-Hmac-Sha256");

  if (!verifyShopifyHmac(rawBody, hmacHeader)) {
    return new Response("Invalid HMAC", { status: 401 });
  }

  const shop = request.headers.get("X-Shopify-Shop-Domain");
  if (!shop) {
    return new Response("Bad Request", { status: 400 });
  }

  const order = JSON.parse(rawBody);
  const customerId = order.customer?.id;

  const {
    getMerchantSettings,
    upsertMerchantSettings,
    getCheckoutVisitor,
    getCustomerRecord,
    setCustomerRecord,
    wasOrderProcessed,
    markOrderProcessed,
  } = await import("../lib/upstash.server");

  // Shopify guarantees at-least-once delivery — ack duplicates without resending.
  if (await wasOrderProcessed(order.id)) {
    return new Response(null, { status: 200 });
  }

  const settings = await getMerchantSettings(shop);
  const audiohookId = settings?.audiohookId;
  if (!audiohookId) {
    console.warn(`[orders-paid] no audiohookId configured for ${shop}, dropping order ${order.id}`);
    // No Audiohook account configured for this shop — ack so Shopify stops retrying.
    return new Response(null, { status: 200 });
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

  // Persist visitor_id and mark this customer as having purchased — fire and
  // forget, doesn't block the response.
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
    order_id: String(order.id),
    value: Number(order.total_price ?? 0),
    currency: order.currency || "USD",
    purchase_type: purchaseType,
    items,
  };

  console.log(`[orders-paid] payload: ${JSON.stringify(payload)}`);

  try {
    const res = await fetch(AUDIOHOOK_INGEST_URL(audiohookId), {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });
    if (!res.ok) {
      const text = await res.text().catch(() => "");
      console.error(`[orders-paid] order ${order.id}: Audiohook API error ${res.status}: ${text}`);
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
    // a Shopify retry would fix. The error above is what needs a real fix.
    await markOrderProcessed(order.id);
  } catch (err) {
    console.error(`[orders-paid] order ${order.id}: failed to forward to Audiohook:`, err.message);
    upsertMerchantSettings(shop, {
      lastEventAt: new Date().toISOString(),
      lastEventStatus: "error",
      lastError: `Network error: ${err.message}`,
    }).catch(() => {});
    // Non-200 tells Shopify to retry delivery — don't mark processed.
    return new Response(null, { status: 500 });
  }

  return new Response(null, { status: 200 });
}
