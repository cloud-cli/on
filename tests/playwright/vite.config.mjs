import { fileURLToPath } from "node:url";
import { defineConfig } from "vite";
import tailwindcss from "@tailwindcss/vite";

export default defineConfig({
  root: fileURLToPath(new URL("../..", import.meta.url)),
  plugins: [tailwindcss()],
  resolve: {
    alias: {
      "@app/api-client.mjs": fileURLToPath(new URL("../../ui/api-client.mjs", import.meta.url)),
      "@li3/web": fileURLToPath(new URL("./recipes-web-stub.mjs", import.meta.url)),
    },
  },
  optimizeDeps: { noDiscovery: true, include: [] },
});
