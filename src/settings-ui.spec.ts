import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { generateSettingsHtml } from "../ui/settings-ui.js";
import settingsSetup from "../ui/settings-ui.mjs?raw";
import serverSetup from "./server.ts?raw";
import timezonePreferences from "../ui/preferences.mjs?raw";
const themeStyles = readFileSync(new URL("../ui/index.css", import.meta.url), "utf8");

describe("personal settings UI", () => {
  it("contains only personal timezone and device notification preferences", () => {
    const html = generateSettingsHtml();
    expect(html).toContain('data-page="settings"');
    expect(html).toContain("Appearance");
    expect(html).toContain('value="system"');
    expect(html).not.toContain("Settings section navigation");
    expect(html).toContain('id="section-timezone"');
    expect(html).toContain('id="section-notifications"');
    expect(html).toContain("Your timezone");
    expect(html).toContain("Notifications");
    expect(html).not.toMatch(/section-(keys|secrets|workers|runners|users)/);
    expect(timezonePreferences).toContain("/api/v1/preferences");
    expect(settingsSetup).toContain("Notification.requestPermission()");
    expect(settingsSetup).not.toMatch(/api-keys|\/api\/v1\/secrets|\/api\/v1\/runners|\/api\/v1\/users/);
  });

  it("validates and persists the user's IANA timezone", () => {
    expect(settingsSetup).toContain("Intl.DateTimeFormat");
    expect(settingsSetup).toContain("new Intl.DateTimeFormat(undefined, { timeZone: selectedTimezone })");
    expect(settingsSetup).toContain('setAuthPreference("timezone", selectedTimezone)');
    expect(settingsSetup).toContain('getAuthPreference("timezone")');
    expect(settingsSetup).toContain('setAuthPreference("theme", value)');
    expect(settingsSetup).toContain('getAuthPreference("theme")');
    expect(serverSetup).toContain("generateSettingsHtml()");
    expect(timezonePreferences).toContain("auth.getPropertyNS(`on:${key}`)");
    expect(timezonePreferences).toContain('apiFetch("/api/v1/preferences"');
    expect(timezonePreferences).toContain('setAuthPreference("timezone", timezone)');
    expect(timezonePreferences).toContain('window.matchMedia("(prefers-color-scheme: dark)")');
    expect(timezonePreferences).toContain('colorSchemeMedia.removeEventListener("change", colorSchemeListener)');
    expect(themeStyles).toContain("#0f1712");
    expect(themeStyles).toContain("#c8e8a5");
    expect(themeStyles).toContain(".bg-emerald-100");
    expect(themeStyles).toContain(".bg-rose-100");
  });
});
