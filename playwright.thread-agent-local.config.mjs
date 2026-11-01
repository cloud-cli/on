import { defineConfig } from "@playwright/test";

export default defineConfig({
  testDir: "./tests/playwright",
  testMatch: "thread-agent-local.spec.mjs",
  fullyParallel: false,
  workers: 1,
  timeout: 180_000,
  expect: { timeout: 20_000 },
  reporter: "line",
  outputDir: "/tmp/opencode/thread-agent-local-results",
  use: { browserName: "chromium", ignoreHTTPSErrors: true, screenshot: "only-on-failure", trace: "retain-on-failure" },
});
