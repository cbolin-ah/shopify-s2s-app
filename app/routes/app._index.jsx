import { useLoaderData, useRouteError } from "@remix-run/react";
import {
  Page,
  Layout,
  Card,
  BlockStack,
  Text,
  Badge,
  Button,
  Banner,
  InlineStack,
  Divider,
  Box,
} from "@shopify/polaris";
import { authenticate } from "../shopify.server";
import { activateThemeEmbedBlock } from "../lib/post-install.server";
import { getOnlineAdminClient } from "../lib/online-admin.server";

export async function action() {
  return null;
}

export async function loader({ request }) {
  const { session, admin } = await authenticate.admin(request);
  const { getMerchantSettings, upsertMerchantSettings } = await import("../lib/upstash.server");
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

  return { settings: { ...settings, cartSyncStatus, cartSyncMessage }, themeEmbedUrl };
}

function StatusItem({ label, description, status, action }) {
  const toneMap = { active: "success", pending: "warning", required: "critical" };
  const labelMap = { active: "Active", pending: "Pending", required: "Action required" };
  return (
    <Box paddingBlockStart="300" paddingBlockEnd="300">
      <InlineStack align="space-between" blockAlign="center">
        <BlockStack gap="050">
          <Text variant="bodyMd" fontWeight="semibold">{label}</Text>
          <Text variant="bodySm" tone="subdued">{description}</Text>
        </BlockStack>
        <InlineStack gap="300" blockAlign="center">
          {action && (
            <Button variant="plain" url={action.url} target="_top" size="slim">
              {action.label}
            </Button>
          )}
          <Badge tone={toneMap[status]}>{labelMap[status]}</Badge>
        </InlineStack>
      </InlineStack>
    </Box>
  );
}

export default function Index() {
  const { settings, themeEmbedUrl } = useLoaderData();
  const hasAudiohookId = !!settings.audiohookId;
  const hasWebhook = hasAudiohookId && !!settings.webhookId;
  const hasPixel = hasAudiohookId && !!settings.pixelId;
  const cartSyncStatus = settings.cartSyncStatus || null;
  const cartSyncMessage = settings.cartSyncMessage || null;
  const cartSyncActive = hasAudiohookId && (cartSyncStatus === 'enabled' || cartSyncStatus === 'already_enabled');

  return (
    <Page
      title="Audiohook"
      subtitle="Server-side conversion tracking"
      primaryAction={{ content: "Settings", url: "/app/settings" }}
    >
      <Layout>
        {!hasAudiohookId && (
          <Layout.Section>
            <Banner
              title="Connect your Audiohook account"
              action={{ content: "Enter Audiohook UUID", url: "/app/settings" }}
              tone="warning"
            >
              <Text>Add your Audiohook UUID to activate server-side tracking.</Text>
            </Banner>
          </Layout.Section>
        )}

        <Layout.Section>
          <Card padding="0">
            <Box paddingInline="500" paddingBlockStart="400" paddingBlockEnd="200">
              <Text variant="headingSm" tone="subdued">CONNECTION STATUS</Text>
            </Box>
            <Box paddingInline="500">
              <Divider />
              <StatusItem
                label="Web Pixel"
                description="Client-side pageview and event tracking"
                status={hasPixel ? "active" : "pending"}
              />
              <Divider />
              <StatusItem
                label="Server-side Events"
                description="Purchase conversions sent directly to Audiohook"
                status={hasWebhook ? "active" : "pending"}
              />
              <Divider />
              <Box paddingBlockStart="300" paddingBlockEnd="300">
                <BlockStack gap="200">
                  <InlineStack align="space-between" blockAlign="center">
                    <BlockStack gap="050">
                      <Text variant="bodyMd" fontWeight="semibold">Cart Sync</Text>
                      <Text variant="bodySm" tone="subdued">Required to associate visitor IDs with purchases</Text>
                    </BlockStack>
                    {cartSyncActive ? (
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
            </Box>
            <Box paddingBlockEnd="200" />
          </Card>
        </Layout.Section>

        {hasAudiohookId && (
          <Layout.Section>
            <Card>
              <InlineStack align="space-between" blockAlign="center">
                <BlockStack gap="100">
                  <Text variant="bodyMd" fontWeight="semibold">Audiohook UUID</Text>
                  <Text variant="bodySm" tone="subdued">{settings.audiohookId}</Text>
                </BlockStack>
                <Button variant="plain" url="/app/settings">Edit</Button>
              </InlineStack>
            </Card>
          </Layout.Section>
        )}
      </Layout>
    </Page>
  );
}

export function ErrorBoundary() {
  const error = useRouteError();
  const msg = error instanceof Error ? error.message : String(error);
  return (
    <Page title="Error">
      <Card>
        <BlockStack gap="400">
          <Text variant="headingMd" tone="critical">Something went wrong</Text>
          <Text>{msg}</Text>
        </BlockStack>
      </Card>
    </Page>
  );
}
