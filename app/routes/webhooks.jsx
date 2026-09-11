import { authenticate } from "../shopify.server";
import { upstashSessionStorage } from "../lib/upstash.server";

const DELETE_WEBHOOK = `#graphql
  mutation webhookDelete($id: ID!) {
    webhookSubscriptionDelete(id: $id) {
      deletedWebhookSubscriptionId
      userErrors { field message }
    }
  }
`;

const DELETE_PIXEL = `#graphql
  mutation webPixelDelete($id: ID!) {
    webPixelDelete(id: $id) {
      deletedWebPixelId
      userErrors { field message }
    }
  }
`;

export const action = async ({ request }) => {
  const { topic, shop, admin, payload } = await authenticate.webhook(request);

  switch (topic) {
    case "APP_UNINSTALLED": {
      const { getMerchantSettings, deleteMerchantConfig } = await import("../lib/upstash.server");
      const settings = await getMerchantSettings(shop);

      if (settings && admin) {
        try {
          if (settings.webhookId) {
            await admin.graphql(DELETE_WEBHOOK, { variables: { id: settings.webhookId } });
          }
        } catch (e) {
          console.warn('[audiohook] could not delete webhook on uninstall:', e.message);
        }
        try {
          if (settings.pixelId) {
            await admin.graphql(DELETE_PIXEL, { variables: { id: settings.pixelId } });
          }
        } catch (e) {
          console.warn('[audiohook] could not delete pixel on uninstall:', e.message);
        }
      }

      await deleteMerchantConfig(shop);

      // Remove the stored session so a stale token can't persist across reinstalls
      await upstashSessionStorage.deleteSession(`offline_${shop}`);

      console.log(`[audiohook] APP_UNINSTALLED for ${shop} — cleaned up`);
      break;
    }

    // Historical snapshots — pick up whichever bulk query is currently in
    // flight for this shop. Only one Bulk Operation can run per shop at a
    // time, so the channel snapshot is submitted from here, chained after
    // the region snapshot finishes, rather than alongside it.
    case "BULK_OPERATIONS_FINISH": {
      try {
        console.log(`[sales-snapshot] raw webhook payload for ${shop}: ${JSON.stringify(payload)}`);
        const bulkOperationGid = payload?.admin_graphql_api_id;
        if (!bulkOperationGid || !admin) break;

        const {
          fetchBulkOperation,
          aggregateOrdersByDayAndRegion,
          aggregateOrdersByDayAndChannel,
          startChannelSnapshotBulkQuery,
        } = await import("../lib/sales-snapshot.server");
        const {
          setSalesSnapshot,
          setChannelSnapshot,
          getBulkOperationKind,
          setBulkOperationKind,
          clearBulkOperationKind,
        } = await import("../lib/upstash.server");

        const op = await fetchBulkOperation(admin, bulkOperationGid);
        if (!op?.url) {
          console.warn(
            `[sales-snapshot] no result url for ${shop} — status=${op?.status} errorCode=${op?.errorCode} objectCount=${op?.objectCount}`
          );
          break;
        }

        const fileRes = await fetch(op.url);
        const jsonlText = await fileRes.text();

        // Missing/legacy kind (an in-flight op submitted before this code
        // shipped) defaults to region — that was the only kind that existed.
        const kind = (await getBulkOperationKind(shop)) || "region-snapshot";

        if (kind === "region-snapshot") {
          const buckets = aggregateOrdersByDayAndRegion(jsonlText);
          await setSalesSnapshot(shop, {
            generatedAt: new Date().toISOString(),
            rangeDays: 365,
            buckets,
          });
          console.log(`[sales-snapshot] stored ${buckets.length} day/region buckets for ${shop}`);

          try {
            await setBulkOperationKind(shop, "channel-snapshot");
            const channelOpId = await startChannelSnapshotBulkQuery(admin);
            console.log(`[sales-snapshot] started channel bulk query ${channelOpId} for ${shop}`);
          } catch (chainErr) {
            console.error(`[sales-snapshot] failed to start channel bulk query for ${shop}:`, chainErr.message);
            await clearBulkOperationKind(shop);
          }
        } else {
          const buckets = aggregateOrdersByDayAndChannel(jsonlText);
          await setChannelSnapshot(shop, {
            generatedAt: new Date().toISOString(),
            rangeDays: 180,
            buckets,
          });
          console.log(`[sales-snapshot] stored ${buckets.length} day/channel buckets for ${shop}`);
          await clearBulkOperationKind(shop);
        }
      } catch (e) {
        let detail;
        if (e instanceof Response) {
          const body = await e.text().catch(() => "");
          detail = `HTTP ${e.status} ${e.statusText || ""} ${body}`.trim();
        } else {
          detail = e?.message || String(e);
        }
        console.error(`[sales-snapshot] failed to process bulk operation for ${shop}: ${detail}`);
      }
      break;
    }

    // Mandatory GDPR webhooks — we store only shop domain, no customer PII
    case "CUSTOMERS_DATA_REQUEST":
    case "CUSTOMERS_REDACT":
    case "SHOP_REDACT":
    case "customers_data_request":
    case "customers_redact":
    case "shop_redact":
      console.log(`[audiohook] GDPR webhook: ${topic} for ${shop}`);
      break;

    default:
      console.warn(`[audiohook] Unhandled webhook topic: ${topic}`);
  }

  return new Response(null, { status: 200 });
};
