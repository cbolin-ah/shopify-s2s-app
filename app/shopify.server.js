import "@shopify/shopify-app-remix/adapters/node";
import {
  ApiVersion,
  AppDistribution,
  shopifyApp,
} from "@shopify/shopify-app-remix/server";
import { boundary } from "@shopify/shopify-app-remix/server";
import { upstashSessionStorage } from "./lib/upstash.server";

// Resolve app URL: explicit env var → Vercel system URL → empty (dev tunnel inferred per-request)
const appUrl =
  process.env.SHOPIFY_APP_URL?.startsWith("https://")
    ? process.env.SHOPIFY_APP_URL
    : process.env.VERCEL_URL
    ? `https://${process.env.VERCEL_URL}`
    : "";

const shopify = shopifyApp({
  apiKey: process.env.SHOPIFY_API_KEY,
  apiSecretKey: process.env.SHOPIFY_API_SECRET || "",
  apiVersion: ApiVersion.April26,
  scopes: process.env.SCOPES?.split(","),
  appUrl,
  authPathPrefix: "/auth",
  sessionStorage: upstashSessionStorage,
  distribution: AppDistribution.AppStore,
  hooks: {
    afterAuth: async ({ session }) => {
      // Webhook and pixel setup is handled in the settings action using online token exchange.
    },
  },
  future: {
    unstable_newEmbeddedAuthStrategy: true,
    // Fixes the persistent 403 on offline-token Admin API calls — Shopify
    // rejects non-expiring offline tokens for apps on the new embedded auth
    // strategy. This makes offline tokens short-lived and auto-refreshed.
    expiringOfflineAccessTokens: true,
  },
  ...(process.env.SHOP_CUSTOM_DOMAIN
    ? { customShopDomains: [process.env.SHOP_CUSTOM_DOMAIN] }
    : {}),
});

export default shopify;
export const apiVersion = ApiVersion.April26;
export const addDocumentResponseHeaders = shopify.addDocumentResponseHeaders;
export const authenticate = shopify.authenticate;
export const unauthenticated = shopify.unauthenticated;
export const login = shopify.login;
export const registerWebhooks = shopify.registerWebhooks;
export const sessionStorage = shopify.sessionStorage;
export { boundary };
