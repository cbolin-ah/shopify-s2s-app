import crypto from "node:crypto";
import { processOrder } from "../lib/order-processing.server";

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

  // Shopify guarantees at-least-once delivery — wasOrderProcessed inside
  // processOrder acks duplicates without resending, same as before.
  const result = await processOrder(shop, order, { source: "webhook" });

  if (!result.forwarded && result.error) {
    // Network error reaching Audiohook — non-200 tells Shopify to retry
    // delivery. (A non-ok Audiohook response, or no audiohookId configured,
    // is NOT retried — see processOrder's comments for why.)
    return new Response(null, { status: 500 });
  }

  return new Response(null, { status: 200 });
}
