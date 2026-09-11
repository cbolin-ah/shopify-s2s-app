// authenticate.admin()'s offline access token gets rejected (HTTP 403) by
// certain Admin API calls — Shopify deprecated non-expiring offline tokens.
// Exchange the request's session token for a short-lived online token instead,
// same pattern already used in the settings action's POST handler.
export async function getOnlineAdminClient(request) {
  const url = new URL(request.url);
  const authHeader = request.headers.get("Authorization");
  const sessionToken = authHeader?.startsWith("Bearer ")
    ? authHeader.slice(7)
    : url.searchParams.get("id_token");

  if (!sessionToken) return null;

  let shop;
  try {
    const payload = JSON.parse(Buffer.from(sessionToken.split(".")[1], "base64").toString());
    shop = payload.dest?.replace("https://", "").replace(/\/$/, "");
  } catch {
    return null;
  }
  if (!shop) return null;

  const tokenRes = await fetch(`https://${shop}/admin/oauth/access_token`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      client_id: process.env.SHOPIFY_API_KEY,
      client_secret: process.env.SHOPIFY_API_SECRET,
      grant_type: "urn:ietf:params:oauth:grant-type:token-exchange",
      subject_token: sessionToken,
      subject_token_type: "urn:ietf:params:oauth:token-type:id_token",
      requested_token_type: "urn:shopify:params:oauth:token-type:online-access-token",
    }),
  });
  const tokenData = await tokenRes.json();
  if (!tokenData?.access_token) return null;

  const apiVersion = "2026-04";
  return {
    shop,
    graphql: async (query, variablesOrUndefined) => {
      const body = variablesOrUndefined
        ? { query, variables: variablesOrUndefined.variables ?? variablesOrUndefined }
        : { query };
      return fetch(`https://${shop}/admin/api/${apiVersion}/graphql.json`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "X-Shopify-Access-Token": tokenData.access_token,
        },
        body: JSON.stringify(body),
      });
    },
  };
}
