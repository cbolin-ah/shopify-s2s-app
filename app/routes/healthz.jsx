import { apiVersion } from "../shopify.server";

export async function loader() {
  return new Response(
    JSON.stringify({
      ok: true,
      apiKey: process.env.SHOPIFY_API_KEY ? "set" : "MISSING",
      appUrl: process.env.SHOPIFY_APP_URL || "MISSING",
      apiVersion,
      ts: Date.now(),
    }),
    { headers: { "Content-Type": "application/json" } }
  );
}
