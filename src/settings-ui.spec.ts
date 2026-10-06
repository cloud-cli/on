import { describe, expect, it } from "vitest";
import { generateSettingsHtml } from "./settings-ui.js";
import settingsSetup from "./settings-ui.mjs?raw";
import serverSetup from "./server.ts?raw";

describe("settings UI", () => {
  it("provides token, notifications, and worker settings without a duplicate workflows link", () => {
    const source = generateSettingsHtml() + settingsSetup;
    expect(source).toContain("/api/api-keys");
    expect(source).toContain("Issue key");
    expect(source).toContain("workflows:write");
    expect(source).toContain("Notifications");
    expect(source).toContain("Workers");
    expect(source).not.toContain('href="/settings/workflows"');
    expect(source).toContain("bg-white");
    expect(source).not.toContain("bg-gray-950");
  });

  it("loads and saves the user's timezone and formats worker/key timestamps", () => {
    const html = generateSettingsHtml("workers") + settingsSetup;
    expect(settingsSetup).toContain("/api/preferences");
    expect(settingsSetup).toContain('method: "PUT"');
    expect(settingsSetup).toContain("Intl.DateTimeFormat");
    expect(settingsSetup).not.toContain("setApiToken");
    expect(settingsSetup).toContain('new Date(text.includes("T") ? text : `${text.replace(" ", "T")}Z`)');
    expect(html).toContain("formatTimestamp(worker.lastSeen)");
    expect(html).toContain("formatTimestamp(key.created_at)");
  });

  it("shows the user roster and protects role changes with confirmation and 403 handling", () => {
    const html = generateSettingsHtml() + settingsSetup;
    expect(html).toContain("/api/users");
    expect(html).toContain("/role");
    expect(html).toContain("confirm(");
    expect(html).toContain("usersForbidden");
    expect(html).toContain("administrators only");
  });

  it("keeps the workers settings route", () => {
    expect(generateSettingsHtml("workers")).toContain('data-page="workers"');
    expect(serverSetup).toMatch(/rawPage\s*===\s*["']workers["']\s*\?\s*["']workers["']\s*:\s*["']tokens["']/);
  });
});
