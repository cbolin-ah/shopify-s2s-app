import { processOrder } from "../lib/order-processing.server";
import { PIXEL_EXTENSION_VERSION } from "../lib/pixel-version.server";

// Runs on a schedule (see vercel.json `crons`). Three jobs per shop:
//   1. Confirm the orders/paid webhook subscription still exists and points
//      here — re-register it if not (Shopify does drop webhooks after
//      sustained delivery failures, and nothing else here would ever notice).
//   2. Re-pull recently-paid orders directly from the Admin API and forward
//      any this app hasn't already processed — catches deliveries that
//      failed outright (outage, bug) that Shopify's own retries gave up on.
//   3. Recreate the shop's WebPixel if it's running stale, CDN-cached code
//      from before the current PIXEL_EXTENSION_VERSION — see
//      pixel-version.server.js for why this has to be a recreate, not just
//      a redeploy.
// (1) and (2) reuse processOrder (app/lib/order-processing.server.js), the
// same logic the real-time webhook uses, so a recovered order gets identical
// attribution/classification treatment to one that arrived on time.

const CALLBACK_URL = "https://cbolin-ah-shop-events-s2s-app.vercel.app/api/orders-paid";
// Vercel Hobby plan caps cron at once/day (see vercel.json), so this window
// has to cover a full day plus margin, not just overlap a tighter interval.
// A missed order can sit unrecovered for up to ~24h before this catches it —
// upgrading to hourly cron (Vercel Pro) would tighten that considerably.
const RECONCILE_WINDOW_MS = 26 * 60 * 60 * 1000; // 26h

const WEBHOOK_QUERY = `#graphql
  query listOrderWebhooks {
    webhookSubscriptions(first: 10, topics: ORDERS_PAID) {
      nodes { id endpoint { __typename ... on WebhookHttpEndpoint { callbackUrl } } }
    }
  }
`;

const CREATE_WEBHOOK = `#graphql
  mutation webhookCreate($topic: WebhookSubscriptionTopic!, $webhookSubscription: WebhookSubscriptionInput!) {
    webhookSubscriptionCreate(topic: $topic, webhookSubscription: $webhookSubscription) {
      webhookSubscription { id }
      userErrors { field message }
    }
  }
`;

// paymentGatewayNames only — no wallet-detail field here (unconfirmed against
// live schema; left out rather than risking the whole query, see
// order-processing.server.js). Recovered orders get purchase_type from
// gateway name only, not apple_pay/google_pay/shopify_pay specifically.
// Paginated (see reconcileRecentOrders) — first: 50 alone would silently
// drop anything past the newest 50 orders in the window for a shop doing
// more volume than that per day.
const RECENT_ORDERS_QUERY = `#graphql
  query recentPaidOrders($query: String!, $cursor: String) {
    orders(first: 50, after: $cursor, query: $query, sortKey: UPDATED_AT) {
      edges {
        node {
          id
          createdAt
          totalPriceSet { shopMoney { amount currencyCode } }
          paymentGatewayNames
          customer { id }
          customAttributes { key value }
          lineItems(first: 50) {
            edges {
              node {
                quantity
                title
                originalUnitPriceSet { shopMoney { amount currencyCode } }
              }
            }
          }
        }
      }
      pageInfo { hasNextPage endCursor }
    }
  }
`;

// The real constraint here is wall-clock time, not order count — Vercel
// functions default to a 30s timeout on the Hobby plan (all shops run
// sequentially in one invocation), and a shop with genuinely unprocessed
// orders to recover costs real time per order (a network call to Audiohook),
// while already-processed ones are a near-instant dedupe check. An
// order-count cap doesn't track that at all: it'd stop early on a busy-but-
// healthy shop while doing nothing to protect a shop with a real backlog.
// Budget the whole run against a shared deadline instead, and stop cleanly
// (logged, not silent) if it's hit — partial work this run still gets
// picked up next run via the same rolling window.
const RUN_TIME_BUDGET_MS = 25000; // 25s, under the 30s Hobby default with margin

function adaptGraphQLOrder(node) {
  const edges = node.lineItems?.edges || [];
  return {
    id: node.id,
    customer: node.customer,
    note_attributes: (node.customAttributes || []).map((a) => ({ name: a.key, value: a.value })),
    // No checkout-token/landing-site equivalent on GraphQL's Order type
    // (confirmed live — REST-only fields). Reconciled orders fall back
    // straight from note_attributes to the customer-record fallback in
    // processOrder, skipping the checkout-token tier; referrer is blank
    // rather than guessed.
    created_at: node.createdAt,
    total_price: node.totalPriceSet?.shopMoney?.amount,
    currency: node.totalPriceSet?.shopMoney?.currencyCode,
    payment_gateway_names: node.paymentGatewayNames,
    // No product_id here — variant/product access needs a read_products
    // scope this app doesn't request, confirmed live (ACCESS_DENIED). Not
    // worth a new scope grant for a backfill safety net; title/price/qty
    // carry the line item without it.
    line_items: edges.map((e) => ({
      product_id: "",
      title: e.node.title,
      price: e.node.originalUnitPriceSet?.shopMoney?.amount,
      quantity: e.node.quantity,
    })),
  };
}

const DELETE_PIXEL = `#graphql
  mutation webPixelDelete($id: ID!) {
    webPixelDelete(id: $id) {
      deletedWebPixelId
      userErrors { field message }
    }
  }
`;

const CREATE_PIXEL = `#graphql
  mutation webPixelCreate($webPixel: WebPixelInput!) {
    webPixelCreate(webPixel: $webPixel) {
      webPixel { id }
      userErrors { field message code }
    }
  }
`;

async function ensurePixelCurrent(admin, shop, settings, upsertMerchantSettings) {
  if (settings?.pixelExtensionVersion === PIXEL_EXTENSION_VERSION) {
    return { recreated: false };
  }
  if (!settings?.pixelId) {
    // Never configured yet — app.settings.jsx handles first-time creation
    // (and stamps the version then). Nothing to recreate here.
    return { recreated: false, skipped: "no-pixel-yet" };
  }

  console.log(
    `[cron-reconcile] pixel stale for ${shop} (have ${settings.pixelExtensionVersion || "none"}, need ${PIXEL_EXTENSION_VERSION}) — recreating`
  );

  try {
    const deleteRes = await admin.graphql(DELETE_PIXEL, { variables: { id: settings.pixelId } });
    const deleteData = await deleteRes.json();
    const deleteErrs = deleteData?.data?.webPixelDelete?.userErrors;
    if (deleteErrs?.length) {
      console.warn(`[cron-reconcile] could not delete old pixel for ${shop}:`, JSON.stringify(deleteErrs));
    }
  } catch (e) {
    console.warn(`[cron-reconcile] could not delete old pixel for ${shop}:`, e.message);
  }

  const createRes = await admin.graphql(CREATE_PIXEL, { variables: { webPixel: { settings: "{}" } } });
  const createData = await createRes.json();
  const errs = createData?.data?.webPixelCreate?.userErrors;
  const newId = createData?.data?.webPixelCreate?.webPixel?.id;

  if (errs?.length || !newId) {
    console.error(`[cron-reconcile] failed to recreate pixel for ${shop}:`, JSON.stringify(errs));
    return { recreated: false, error: JSON.stringify(errs) };
  }

  await upsertMerchantSettings(shop, { pixelId: newId, pixelExtensionVersion: PIXEL_EXTENSION_VERSION });
  console.log(`[cron-reconcile] recreated pixel for ${shop}: ${newId}`);
  return { recreated: true, newId };
}

async function checkAndHealWebhook(admin, shop, upsertMerchantSettings) {
  const res = await admin.graphql(WEBHOOK_QUERY);
  const data = await res.json();
  const subs = data?.data?.webhookSubscriptions?.nodes || [];
  const healthy = subs.some((s) => s.endpoint?.callbackUrl === CALLBACK_URL);

  if (!healthy) {
    console.error(`[cron-reconcile] orders/paid webhook missing for ${shop} — re-registering`);
    const createRes = await admin.graphql(CREATE_WEBHOOK, {
      variables: { topic: "ORDERS_PAID", webhookSubscription: { callbackUrl: CALLBACK_URL, format: "JSON" } },
    });
    const createData = await createRes.json();
    const errs = createData?.data?.webhookSubscriptionCreate?.userErrors;
    const newId = createData?.data?.webhookSubscriptionCreate?.webhookSubscription?.id;
    if (errs?.length) {
      console.error(`[cron-reconcile] failed to re-register webhook for ${shop}:`, JSON.stringify(errs));
    } else if (newId) {
      await upsertMerchantSettings(shop, { webhookId: newId });
    }
  }

  await upsertMerchantSettings(shop, {
    lastWebhookCheck: new Date().toISOString(),
    webhookHealthy: healthy,
  });

  return healthy;
}

async function reconcileRecentOrders(admin, shop, upsertMerchantSettings, deadline) {
  const since = new Date(Date.now() - RECONCILE_WINDOW_MS).toISOString();
  const query = `financial_status:paid AND updated_at:>=${since}`;

  let cursor = null;
  let checked = 0;
  let recovered = 0;
  let truncated = false;

  while (true) {
    if (Date.now() > deadline) {
      console.warn(`[cron-reconcile] time budget exhausted for ${shop} mid-reconciliation — ${checked} checked so far, resuming next run`);
      truncated = true;
      break;
    }

    const res = await admin.graphql(RECENT_ORDERS_QUERY, { variables: { query, cursor } });
    const data = await res.json();
    if (data?.errors) {
      throw new Error(`recentPaidOrders GraphQL errors: ${JSON.stringify(data.errors)}`);
    }
    const edges = data?.data?.orders?.edges || [];
    checked += edges.length;

    for (const { node } of edges) {
      const result = await processOrder(shop, adaptGraphQLOrder(node), { source: "reconcile" });
      if (result.forwarded) recovered += 1;
    }

    const pageInfo = data?.data?.orders?.pageInfo;
    if (!pageInfo?.hasNextPage) break;
    cursor = pageInfo.endCursor;
  }

  await upsertMerchantSettings(shop, {
    lastReconcileAt: new Date().toISOString(),
    lastReconcileChecked: checked,
    lastReconcileRecovered: recovered,
    lastReconcileTruncated: truncated,
  });

  return { checked, recovered, truncated };
}

export async function loader({ request }) {
  // Fail closed: if CRON_SECRET isn't configured, refuse rather than leave
  // this endpoint open (it triggers Admin API calls per shop on every hit).
  const authHeader = request.headers.get("authorization");
  if (!process.env.CRON_SECRET || authHeader !== `Bearer ${process.env.CRON_SECRET}`) {
    return new Response("Unauthorized", { status: 401 });
  }

  const { getActiveShops, getMerchantSettings, upsertMerchantSettings } = await import("../lib/upstash.server");
  const { getOfflineAdminClient } = await import("../lib/sales-snapshot.server");

  const shops = await getActiveShops();
  const results = [];
  const deadline = Date.now() + RUN_TIME_BUDGET_MS;

  // Sequential, not parallel — fine at current shop counts. Revisit with a
  // concurrency cap if this app scales to many more installs, to stay under
  // Shopify's per-shop API rate limits without adding complexity for a scale
  // that doesn't exist yet.
  for (const shop of shops) {
    if (Date.now() > deadline) {
      console.warn(`[cron-reconcile] time budget exhausted — skipping remaining shops this run: ${shops.slice(results.length).join(", ")}`);
      results.push(...shops.slice(results.length).map((s) => ({ shop: s, skipped: "time-budget-exceeded" })));
      break;
    }
    try {
      const admin = await getOfflineAdminClient(shop);
      if (!admin) {
        results.push({ shop, error: "no offline session" });
        continue;
      }
      const settings = await getMerchantSettings(shop);
      const pixel = await ensurePixelCurrent(admin, shop, settings, upsertMerchantSettings);
      const webhookHealthy = await checkAndHealWebhook(admin, shop, upsertMerchantSettings);
      const { checked, recovered, truncated } = await reconcileRecentOrders(admin, shop, upsertMerchantSettings, deadline);
      results.push({ shop, pixelRecreated: pixel.recreated, webhookHealthy, ordersChecked: checked, recovered, truncated });
    } catch (err) {
      console.error(`[cron-reconcile] failed for ${shop}:`, err.message);
      results.push({ shop, error: err.message });
    }
  }

  console.log(`[cron-reconcile] run complete: ${JSON.stringify(results)}`);

  return new Response(JSON.stringify({ ok: true, results }), {
    headers: { "Content-Type": "application/json" },
  });
}
