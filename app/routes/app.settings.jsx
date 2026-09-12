import { useState, useCallback, useEffect } from "react";
import { useLoaderData, useFetcher } from "@remix-run/react";
import { useAppBridge } from "@shopify/app-bridge-react";
import {
  Page,
  Layout,
  Card,
  FormLayout,
  TextField,
  Button,
  Banner,
  Text,
  BlockStack,
  InlineStack,
  Badge,
  Divider,
  Box,
  Collapsible,
} from "@shopify/polaris";
import { authenticate } from "../shopify.server";
import { createOrUpdateWebPixel, activateThemeEmbedBlock } from "../lib/post-install.server";
import { getOnlineAdminClient } from "../lib/online-admin.server";
import { PIXEL_EXTENSION_VERSION } from "../lib/pixel-version.server";

const REGISTER_WEBHOOK = `#graphql
  mutation webhookCreate($topic: WebhookSubscriptionTopic!, $webhookSubscription: WebhookSubscriptionInput!) {
    webhookSubscriptionCreate(topic: $topic, webhookSubscription: $webhookSubscription) {
      webhookSubscription { id }
      userErrors { field message }
    }
  }
`;

const LIST_WEBHOOKS = `#graphql
  query listWebhooks {
    webhookSubscriptions(first: 25, topics: ORDERS_PAID) {
      nodes { id endpoint { __typename ... on WebhookHttpEndpoint { callbackUrl } } }
    }
  }
`;

const DELETE_WEBHOOK = `#graphql
  mutation webhookDelete($id: ID!) {
    webhookSubscriptionDelete(id: $id) {
      deletedWebhookSubscriptionId
      userErrors { field message }
    }
  }
`;

const VERCEL_WEBHOOK_URL = "https://cbolin-ah-shop-events-s2s-app.vercel.app/api/orders-paid";

async function ensureWebhook(admin) {
  const listRes = await admin.graphql(LIST_WEBHOOKS);
  const listData = await listRes.json();
  if (listData?.errors) throw new Error("list webhooks errors: " + JSON.stringify(listData.errors));

  const nodes = listData?.data?.webhookSubscriptions?.nodes || [];

  // Remove stale webhooks using the old ?client= URL format
  for (const node of nodes) {
    const url = node.endpoint?.callbackUrl || '';
    if (url.startsWith(VERCEL_WEBHOOK_URL) && url.includes('?client=')) {
      await admin.graphql(DELETE_WEBHOOK, { variables: { id: node.id } });
    }
  }

  const existing = nodes.find(n => n.endpoint?.callbackUrl === VERCEL_WEBHOOK_URL);
  if (existing) return existing.id;

  const createRes = await admin.graphql(REGISTER_WEBHOOK, {
    variables: {
      topic: "ORDERS_PAID",
      webhookSubscription: { callbackUrl: VERCEL_WEBHOOK_URL, format: "JSON" },
    },
  });
  const createData = await createRes.json();
  const errs = createData?.data?.webhookSubscriptionCreate?.userErrors;
  if (errs?.length) throw new Error("webhookSubscriptionCreate errors: " + JSON.stringify(errs));
  return createData?.data?.webhookSubscriptionCreate?.webhookSubscription?.id ?? null;
}

function jsonResponse(data, init) {
  return new Response(JSON.stringify(data), {
    status: init?.status ?? 200,
    headers: { 'Content-Type': 'application/json' },
  });
}

export async function loader({ request }) {
  const { getMerchantSettings, upsertMerchantSettings } = await import("../lib/upstash.server");
  const { session, admin } = await authenticate.admin(request);
  const settings = await getMerchantSettings(session.shop);
  const themeEmbedUrl = `https://${session.shop}/admin/themes/current/editor?context=apps`;

  // Re-verify live rather than trust the last saved snapshot — if the
  // merchant switched themes since Cart Sync was last activated, a cached
  // "Active" status would otherwise keep showing on a theme it never ran on.
  let cartSyncStatus = settings?.cartSyncStatus || null;
  let cartSyncMessage = settings?.cartSyncMessage || null;
  try {
    const onlineAdmin = await getOnlineAdminClient(request);
    const result = await activateThemeEmbedBlock(onlineAdmin ?? admin, session);
    if (result?.status && result.status !== cartSyncStatus) {
      cartSyncStatus = result.status;
      cartSyncMessage = result.message || null;
      await upsertMerchantSettings(session.shop, { cartSyncStatus, cartSyncMessage });
    }
  } catch (e) {
    // keep last known status rather than fail the page load
  }

  return {
    audiohookId: settings?.audiohookId || "",
    isActive: settings?.isActive || false,
    pixelId: settings?.pixelId || null,
    webhookId: settings?.webhookId || null,
    cartSyncStatus,
    cartSyncMessage,
    themeEmbedUrl,
  };
}

export async function action({ request }) {
  try {
    return await settingsAction(request);
  } catch (err) {
    return jsonResponse({ error: `Unexpected error: ${err instanceof Error ? err.message : String(err)}` }, { status: 500 });
  }
}

async function settingsAction(request) {
  // Read session token from form body (not Authorization header) to avoid
  // the Shopify middleware intercepting the request and redirecting to auth.
  const formData = await request.formData();
  const sessionToken = String(formData.get("_sessionToken") || "");
  const audiohookId = String(formData.get("audiohookId") || "").trim();

  // Extract shop from the App Bridge JWT (dest claim) and exchange for an online
  // access token. Online tokens expire in 24h and are never rejected for
  // non-expiring token deprecation.
  let shop;
  try {
    const payload = JSON.parse(Buffer.from(sessionToken.split('.')[1], 'base64').toString());
    shop = payload.dest?.replace('https://', '').replace(/\/$/, '');
  } catch (e) {
    return jsonResponse({ error: 'Invalid session token' }, { status: 401 });
  }

  const tokenRes = await fetch(`https://${shop}/admin/oauth/access_token`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      client_id: process.env.SHOPIFY_API_KEY,
      client_secret: process.env.SHOPIFY_API_SECRET,
      grant_type: 'urn:ietf:params:oauth:grant-type:token-exchange',
      subject_token: sessionToken,
      subject_token_type: 'urn:ietf:params:oauth:token-type:id_token',
      requested_token_type: 'urn:shopify:params:oauth:token-type:online-access-token',
    }),
  });
  const tokenData = await tokenRes.json();
  if (!tokenData?.access_token) {
    return jsonResponse({ error: `Token exchange failed: ${JSON.stringify(tokenData)}` }, { status: 401 });
  }
  const onlineToken = tokenData.access_token;

  const apiVersion = "2026-04";
  const directAdmin = {
    graphql: async (query, variablesOrUndefined) => {
      const body = variablesOrUndefined
        ? { query, variables: variablesOrUndefined.variables ?? variablesOrUndefined }
        : { query };
      return fetch(`https://${shop}/admin/api/${apiVersion}/graphql.json`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-Shopify-Access-Token': onlineToken,
        },
        body: JSON.stringify(body),
      });
    },
  };
  // session object for activateThemeEmbedBlock (needs session.shop)
  const session = { shop, accessToken: onlineToken };

  const uuidRegex =
    /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
  if (!uuidRegex.test(audiohookId)) {
    return jsonResponse({ error: "Invalid Audiohook ID format. Must be a UUID (e.g. 48197d46-f4d4-44e4-84c1-3db837381b3b)." });
  }

  const { getMerchantSettings, upsertMerchantSettings } = await import("../lib/upstash.server");
  const existing = await getMerchantSettings(session.shop);

  // Run pixel and webhook creation in parallel to minimize execution time
  let pixelId = existing?.pixelId ?? null;
  let webhookId = existing?.webhookId ?? null;
  let pixelWarning = null;

  const [pixelResult, webhookResult] = await Promise.allSettled([
    createOrUpdateWebPixel(directAdmin, audiohookId, pixelId),
    ensureWebhook(directAdmin),
  ]);

  if (pixelResult.status === 'fulfilled') {
    pixelId = pixelResult.value;
  } else {
    if (pixelResult.reason instanceof Response) return pixelResult.reason;
    pixelWarning = pixelResult.reason instanceof Error ? pixelResult.reason.message : String(pixelResult.reason);
  }

  if (webhookResult.status === 'fulfilled') {
    webhookId = webhookResult.value;
  }
  // webhook failure is non-fatal; merchant can retry by saving again

  // Auto-activate Cart Sync embed block in merchant's live theme
  let cartSyncStatus = null;
  let cartSyncMessage = null;
  try {
    const cartSyncResult = await activateThemeEmbedBlock(directAdmin, session);
    cartSyncStatus = cartSyncResult?.status ?? 'error';
    cartSyncMessage = cartSyncResult?.message ?? null;
  } catch (e) {
    cartSyncStatus = 'error';
    cartSyncMessage = e instanceof Error ? e.message : String(e);
  }

  const status = pixelWarning ? "error" : "active";
  const now = new Date().toISOString();

  await upsertMerchantSettings(session.shop, {
    audiohookId,
    pixelId,
    pixelExtensionVersion: PIXEL_EXTENSION_VERSION,
    webhookId,
    isActive: true,
    cartSyncStatus,
    cartSyncMessage,
    status,
    registeredAt: existing?.registeredAt || now,
    lastUpdatedAt: now,
    lastError: pixelWarning || null,
  });

  // First time this shop connects an Audiohook ID — kick off a one-time
  // historical sales snapshot (past year, by day/region). Bulk operation
  // completes async; result is picked up by the BULK_OPERATIONS_FINISH
  // webhook. Isolated failure here must never affect the settings save itself.
  if (!existing?.registeredAt) {
    try {
      const { startSalesSnapshotBulkQuery, getOfflineAdminClient } = await import(
        "../lib/sales-snapshot.server"
      );
      // Submit with the offline token, not directAdmin (online) — the
      // BULK_OPERATIONS_FINISH webhook can only query it back later using
      // the offline admin context, and Shopify scopes visibility to whichever
      // session submitted it.
      const offlineAdmin = await getOfflineAdminClient(session.shop);
      if (!offlineAdmin) {
        throw new Error("no stored offline session for this shop yet");
      }
      const { setBulkOperationKind } = await import("../lib/upstash.server");
      await setBulkOperationKind(session.shop, "region-snapshot");
      const bulkOperationId = await startSalesSnapshotBulkQuery(offlineAdmin);
      console.log(`[sales-snapshot] started bulk query ${bulkOperationId} for ${session.shop}`);
    } catch (e) {
      console.error(`[sales-snapshot] failed to start bulk query for ${session.shop}:`, e.message);
    }
  }

  if (pixelWarning) {
    return jsonResponse({
      success: true,
      pixelId,
      webhookId,
      cartSyncStatus,
      cartSyncMessage,
      warning: `Settings saved. Web pixel setup needs attention: ${pixelWarning}. Try reinstalling the app if this persists.`,
    });
  }

  return jsonResponse({ success: true, pixelId, webhookId, cartSyncStatus, cartSyncMessage });
}

export default function Settings() {
  const { audiohookId, pixelId: initialPixelId, webhookId: initialWebhookId, cartSyncStatus: initialCartSyncStatus, cartSyncMessage: initialCartSyncMessage, themeEmbedUrl } = useLoaderData();
  const appBridge = useAppBridge();
  const fetcher = useFetcher();
  const [actionData, setActionData] = useState(null);
  const [idValue, setIdValue] = useState(audiohookId);
  const [detailsOpen, setDetailsOpen] = useState(false);

  const saving = fetcher.state !== 'idle';
  const displayData = fetcher.data ?? actionData;
  const pixelId = displayData?.pixelId ?? initialPixelId;
  const webhookId = displayData?.webhookId ?? initialWebhookId;
  const cartSyncStatus = displayData?.cartSyncStatus ?? initialCartSyncStatus;
  const cartSyncMessage = displayData?.cartSyncMessage ?? initialCartSyncMessage;

  useEffect(() => {
    if (fetcher.state === 'idle' && fetcher.data) {
      setActionData(fetcher.data);
    }
  }, [fetcher.state, fetcher.data]);

  const handleSubmit = useCallback(async (e) => {
    e.preventDefault();
    try {
      const sessionToken = await appBridge.idToken();
      fetcher.submit(
        { audiohookId: idValue, _sessionToken: sessionToken },
        { method: "POST" }
      );
    } catch (err) {
      setActionData({ error: "Failed to get session token. Please try again." });
    }
  }, [appBridge, idValue, fetcher]);

  return (
    <Page
      title="Settings"
      backAction={{ content: "Overview", url: "/app" }}
    >
      <Layout>
        {displayData?.error && (
          <Layout.Section>
            <Banner tone="critical" title="Error">
              <Text>{displayData?.error}</Text>
            </Banner>
          </Layout.Section>
        )}
        {displayData?.success && !displayData?.warning && (
          <Layout.Section>
            <Banner tone="success" title="Settings saved">
              <Text>Audiohook tracking is now active for your store.</Text>
            </Banner>
          </Layout.Section>
        )}
        {displayData?.warning && (
          <Layout.Section>
            <Banner tone="warning" title="Saved with a note">
              <Text>{displayData?.warning}</Text>
            </Banner>
          </Layout.Section>
        )}

        <Layout.Section>
          <Card>
            <form onSubmit={handleSubmit}>
              <BlockStack gap="500">
                <BlockStack gap="100">
                  <Text variant="headingMd">Audiohook Account ID</Text>
                  <Text tone="subdued" variant="bodySm">
                    Contact your Audiohook Client Success Manager for your unique ID.
                  </Text>
                </BlockStack>
                <FormLayout>
                  <TextField
                    label="Audiohook UUID"
                    name="audiohookId"
                    value={idValue}
                    onChange={setIdValue}
                    placeholder="xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx"
                    autoComplete="off"
                    helpText="UUID format — e.g. 48197d46-f4d4-44e4-84c1-3db837381b3b"
                  />
                </FormLayout>
                <Button submit variant="primary" loading={saving}>
                  Save
                </Button>
              </BlockStack>
            </form>
          </Card>
        </Layout.Section>

        <Layout.Section>
          <Card padding="0">
            <Box paddingInline="500" paddingBlockStart="400" paddingBlockEnd="200">
              <Text variant="headingSm" tone="subdued">CONNECTION STATUS</Text>
            </Box>
            <Box paddingInline="500">
              <Divider />
              <Box paddingBlockStart="300" paddingBlockEnd="300">
                <InlineStack align="space-between" blockAlign="center">
                  <BlockStack gap="050">
                    <Text variant="bodyMd" fontWeight="semibold">Web Pixel</Text>
                    <Text variant="bodySm" tone="subdued">Client-side event tracking</Text>
                  </BlockStack>
                  <Badge tone={pixelId ? "success" : "warning"}>
                    {pixelId ? "Active" : "Pending"}
                  </Badge>
                </InlineStack>
              </Box>
              <Divider />
              <Box paddingBlockStart="300" paddingBlockEnd="300">
                <InlineStack align="space-between" blockAlign="center">
                  <BlockStack gap="050">
                    <Text variant="bodyMd" fontWeight="semibold">Server-side Events</Text>
                    <Text variant="bodySm" tone="subdued">Purchase conversions via webhook</Text>
                  </BlockStack>
                  <Badge tone={webhookId ? "success" : "warning"}>
                    {webhookId ? "Active" : "Pending"}
                  </Badge>
                </InlineStack>
              </Box>
              <Divider />
              <Box paddingBlockStart="300" paddingBlockEnd="300">
                <BlockStack gap="200">
                  <InlineStack align="space-between" blockAlign="center">
                    <BlockStack gap="050">
                      <Text variant="bodyMd" fontWeight="semibold">Cart Sync</Text>
                      <Text variant="bodySm" tone="subdued">Required for visitor ID matching</Text>
                    </BlockStack>
                    {!!webhookId && (cartSyncStatus === 'enabled' || cartSyncStatus === 'already_enabled') ? (
                      <Badge tone="success">Active</Badge>
                    ) : cartSyncStatus === 'legacy_theme' ? (
                      <Badge tone="critical">Not available</Badge>
                    ) : (
                      <InlineStack gap="300" blockAlign="center">
                        <Button variant="plain" url={themeEmbedUrl} target="_top" size="slim">
                          Enable in Theme →
                        </Button>
                        <Badge tone="warning">Action required</Badge>
                      </InlineStack>
                    )}
                  </InlineStack>
                  {cartSyncStatus === 'legacy_theme' && (
                    <Banner tone="critical">
                      <Text variant="bodySm">
                        {cartSyncMessage || "Cart Sync is not available for your theme."} Contact{" "}
                        <a href="mailto:cbolin@audiohook.com">cbolin@audiohook.com</a>{" "}
                        to resolve this error.
                      </Text>
                    </Banner>
                  )}
                  {cartSyncStatus === 'error' && cartSyncMessage && (
                    <Banner tone="warning">
                      <Text variant="bodySm">{cartSyncMessage}</Text>
                    </Banner>
                  )}
                </BlockStack>
              </Box>
              <Divider />
              <Box paddingBlockStart="200" paddingBlockEnd="300">
                <Button
                  variant="plain"
                  onClick={() => setDetailsOpen(o => !o)}
                  ariaExpanded={detailsOpen}
                >
                  {detailsOpen ? "Hide details" : "Show details"}
                </Button>
                <Collapsible open={detailsOpen} id="integration-details">
                  <Box paddingBlockStart="300">
                    <BlockStack gap="100">
                      {webhookId && (
                        <Text variant="bodySm" tone="subdued">Webhook ID: {webhookId}</Text>
                      )}
                      {pixelId && (
                        <Text variant="bodySm" tone="subdued">Pixel ID: {pixelId}</Text>
                      )}
                    </BlockStack>
                  </Box>
                </Collapsible>
              </Box>
            </Box>
          </Card>
        </Layout.Section>
      </Layout>
    </Page>
  );
}
