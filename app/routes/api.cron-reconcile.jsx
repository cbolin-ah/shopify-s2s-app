import { processOrder } from "../lib/order-processing.server";

// Runs on a schedule (see vercel.json `crons`). Two jobs per shop:
//   1. Confirm the orders/paid webhook subscription still exists and points
//      here — re-register it if not (Shopify does drop webhooks after
//      sustained delivery failures, and nothing else here would ever notice).
//   2. Re-pull recently-paid orders directly from the Admin API and forward
//      any this app hasn't already processed — catches deliveries that
//      failed outright (outage, bug) that Shopify's own retries gave up on.
// Both reuse processOrder (app/lib/order-processing.server.js), the same
// logic the real-time webhook uses, so a recovered order gets identical
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
const RECENT_ORDERS_QUERY = `#graphql
  query recentPaidOrders($query: String!) {
    orders(first: 50, query: $query, sortKey: UPDATED_AT) {
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
    }
  }
`;

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

async function reconcileRecentOrders(admin, shop, upsertMerchantSettings) {
  const since = new Date(Date.now() - RECONCILE_WINDOW_MS).toISOString();
  const res = await admin.graphql(RECENT_ORDERS_QUERY, {
    variables: { query: `financial_status:paid AND updated_at:>=${since}` },
  });
  const data = await res.json();
  if (data?.errors) {
    throw new Error(`recentPaidOrders GraphQL errors: ${JSON.stringify(data.errors)}`);
  }
  const edges = data?.data?.orders?.edges || [];

  let recovered = 0;
  for (const { node } of edges) {
    const result = await processOrder(shop, adaptGraphQLOrder(node), { source: "reconcile" });
    if (result.forwarded) recovered += 1;
  }

  await upsertMerchantSettings(shop, {
    lastReconcileAt: new Date().toISOString(),
    lastReconcileChecked: edges.length,
    lastReconcileRecovered: recovered,
  });

  return { checked: edges.length, recovered };
}

export async function loader({ request }) {
  // Fail closed: if CRON_SECRET isn't configured, refuse rather than leave
  // this endpoint open (it triggers Admin API calls per shop on every hit).
  const authHeader = request.headers.get("authorization");
  if (!process.env.CRON_SECRET || authHeader !== `Bearer ${process.env.CRON_SECRET}`) {
    return new Response("Unauthorized", { status: 401 });
  }

  const { getActiveShops, upsertMerchantSettings } = await import("../lib/upstash.server");
  const { getOfflineAdminClient } = await import("../lib/sales-snapshot.server");

  const shops = await getActiveShops();
  const results = [];

  // Sequential, not parallel — fine at current shop counts. Revisit with a
  // concurrency cap if this app scales to many more installs, to stay under
  // Shopify's per-shop API rate limits without adding complexity for a scale
  // that doesn't exist yet.
  for (const shop of shops) {
    try {
      const admin = await getOfflineAdminClient(shop);
      if (!admin) {
        results.push({ shop, error: "no offline session" });
        continue;
      }
      const webhookHealthy = await checkAndHealWebhook(admin, shop, upsertMerchantSettings);
      const { checked, recovered } = await reconcileRecentOrders(admin, shop, upsertMerchantSettings);
      results.push({ shop, webhookHealthy, ordersChecked: checked, recovered });
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
