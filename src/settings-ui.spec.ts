import { describe, expect, it } from "vitest";
import { generateSettingsHtml } from "../ui/settings-ui.js";
import settingsSetup from "../ui/settings-ui.mjs?raw";
import serverSetup from "./server.ts?raw";

describe("personal settings UI", () => {
  it("contains only personal timezone and device notification preferences", () => {
    const html = generateSettingsHtml();
    expect(html).toContain('data-page="settings"');
    expect(html).toContain('id="section-timezone"');
    expect(html).toContain('id="section-notifications"');
    expect(html).toContain("Your timezone");
    expect(html).toContain("Notifications");
    expect(html).not.toMatch(/section-(keys|secrets|workers|runners|users)/);
    expect(settingsSetup).toContain("/api/v1/preferences");
    expect(settingsSetup).toContain("Notification.requestPermission()");
    expect(settingsSetup).not.toMatch(/api-keys|\/api\/v1\/secrets|\/api\/v1\/runners|\/api\/v1\/users/);
  });

  it("validates and persists the user's IANA timezone", () => {
    expect(settingsSetup).toContain('method: "PUT"');
    expect(settingsSetup).toContain("Intl.DateTimeFormat");
    expect(settingsSetup).toContain("new Intl.DateTimeFormat(undefined, { timeZone: selectedTimezone })");
    expect(settingsSetup).toContain("timezone.value = saved.timezone");
    expect(serverSetup).toContain("generateSettingsHtml()");
  });
});
