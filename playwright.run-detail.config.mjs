import { defineConfig } from "@playwright/test";

const port = 28081;
const baseURL = `http://127.0.0.1:${port}`;

export default defineConfig({
  testDir: "./tests/playwright",
  testMatch: "run-detail-nested-call.mjs",
  fullyParallel: true,
  reporter: "list",
  outputDir: "test-results/run-detail",
  use: { baseURL, trace: "retain-on-failure" },
  webServer: {
    command: `pnpm build && RUN_DETAIL_PORT=${port} node tests/playwright/run-detail-server.mjs`,
    url: `${baseURL}/ui/runs/nested-fixture`,
    reuseExistingServer: false,
  },
});
