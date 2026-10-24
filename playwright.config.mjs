import { defineConfig } from "@playwright/test";

export default defineConfig({
  testDir: "./tests/playwright",
  fullyParallel: true,
  reporter: "list",
  outputDir: "test-results/channels",
  use: { baseURL: "http://127.0.0.1:4179", trace: "retain-on-failure" },
  webServer: {
    command: "pnpm exec vite --config tests/playwright/vite.config.mjs --host 127.0.0.1 --port 4179 --strictPort",
    url: "http://127.0.0.1:4179/tests/playwright/channel-harness.html",
    reuseExistingServer: !process.env.CI,
  },
});
