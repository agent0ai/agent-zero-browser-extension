import { crx } from "@crxjs/vite-plugin";
import preact from "@preact/preset-vite";
import { defineConfig } from "vite";

import { createManifest } from "./src/manifest";
import { buildChannelForMode } from "./src/build-channel";

export default defineConfig(({ mode }) => ({
  plugins: [preact(), crx({ manifest: createManifest(mode) })],
  define: { __A0_LOCAL_DEVELOPMENT__: mode === "local-development" },
  build: { outDir: buildChannelForMode(mode).outDir },
  test: {
    exclude: ["tests/e2e/**", "node_modules/**", "dist/**", "dist-development/**"],
    globals: true,
  },
}));
