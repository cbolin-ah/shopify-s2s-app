const AUDIOHOOK_INGEST_URL = (audiohookId) =>
  `https://listen.audiohook.com/${audiohookId}/pixel.png`;

const CORS_HEADERS = { "Access-Control-Allow-Origin": "*" };

function ok() {
  return new Response(null, { status: 200, headers: CORS_HEADERS });
}

// Every standard Web Pixel event (page/product/cart/search/checkout-stage)
// lands here and gets forwarded server-side to Audiohook, same ingest
// endpoint as orders-paid. Deliberately fire-and-forget — the pixel never
// retries, and there's no order-level attribution work to do here, unlike
// api.orders-paid.jsx.
export async function action({ request }) {
  let body;
  try {
    body = JSON.parse(await request.text());
  } catch {
    return ok();
  }

  const { event_name: eventName, audiohookId: clientAudiohookId, shop, ...fields } = body || {};
  if (!eventName) return ok();

  // Pixel caches audiohookId client-side after its first /api/pixel-config
  // lookup and sends it with every event — avoids a Redis round trip per
  // event. Shop lookup is only a fallback for events that queued before that
  // cache warmed.
  let audiohookId = clientAudiohookId;
  if (!audiohookId && shop) {
    const { getMerchantSettings } = await import("../lib/upstash.server");
    const settings = await getMerchantSettings(shop);
    audiohookId = settings?.audiohookId;
  }
  if (!audiohookId) return ok();

  const payload = { name: eventName, event_name: eventName, shop, ...fields };

  try {
    const res = await fetch(AUDIOHOOK_INGEST_URL(audiohookId), {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });
    if (!res.ok) {
      const text = await res.text().catch(() => "");
      console.error(`[pixel-event] ${eventName}: Audiohook API error ${res.status}: ${text}`);
    }
  } catch (err) {
    console.error(`[pixel-event] ${eventName}: failed to forward to Audiohook:`, err.message);
  }

  return ok();
}
