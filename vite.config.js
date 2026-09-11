import { vitePlugin as remix } from "@remix-run/dev";
import { defineConfig } from "vite";
import tsconfigPaths from "vite-tsconfig-paths";

export default defineConfig({
  plugins: [
    remix({
      ignoredRouteFiles: ["**/.*"],
      future: {
        v3_fetcherPersist: true,
        v3_relativeSplatPath: true,
        v3_throwAbortReason: true,
        v3_singleFetch: false,
        v3_lazyRouteDiscovery: false,
      },
    }),
    tsconfigPaths(),
  ],
  build: {
    assetsInlineLimit: 0,
  },
  server: {
    allowedHosts: true,
    port: Number(process.env.PORT || 3000),
    warmup: {
      clientFiles: ["./app/entry.client.jsx"],
      serverFiles: ["./app/entry.server.jsx"],
    },
  },
  optimizeDeps: {
    include: ["react", "react-dom"],
  },
});
