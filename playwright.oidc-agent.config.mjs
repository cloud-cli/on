import { defineConfig } from "@playwright/test";

export default defineConfig({
  testDir: "./tests/playwright",
  testMatch: "oidc-agent.spec.mjs",
  fullyParallel: false,
  workers: 1,
  timeout: 150_000,
  expect: { timeout: 20_000 },
  reporter: "line",
  outputDir: "/tmp/opencode/oidc-agent-results",
  use: {
    browserName: "chromium",
    screenshot: "off",
    trace: "off",
    video: "off",
  },
});
