// Bump this string whenever extensions/audiohook-pixel/src/index.js changes
// and gets shipped via `shopify app deploy`.
//
// Why this needs to exist at all: Shopify CDN-caches a shop's Web Pixel
// bundle URL for a year (max-age=31536000), so a `shopify app deploy` alone
// does NOT reach shops that already have the pixel installed — their browser
// keeps serving the old cached code indefinitely. The only way to force a
// shop onto new pixel code is to delete and recreate its WebPixel resource,
// which gets it a brand-new, never-cached URL.
//
// The daily reconciliation cron (api.cron-reconcile.jsx) compares each
// shop's stored pixelExtensionVersion against this constant and recreates
// the pixel automatically when they don't match — so shipping new pixel
// code plus bumping this string is the entire "ship it" step; no manual
// per-shop recreation needed afterward.
export const PIXEL_EXTENSION_VERSION = "2026-09-12.1";
