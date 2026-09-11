// The pixel posts with Content-Type: text/plain (not application/json) so the
// browser treats this as a CORS-simple request and skips preflight — Remix's
// resource routes don't handle OPTIONS. request.json() still parses the body fine.
const CORS_HEADERS = { "Access-Control-Allow-Origin": "*" };

export async function action({ request }) {
  const { setCheckoutVisitor } = await import("../lib/upstash.server");

  try {
    const { token, visitorId, sessionId } = await request.json();
    if (token && visitorId) {
      await setCheckoutVisitor(token, { visitorId, sessionId: sessionId || null });
    }
  } catch {
    // Pixel fire-and-forget — swallow malformed bodies rather than error the checkout.
  }

  return new Response(JSON.stringify({ ok: true }), {
    headers: { ...CORS_HEADERS, "Content-Type": "application/json" },
  });
}
