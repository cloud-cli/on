import { describe, expect, it } from "vitest";
import { generateSettingsHtml } from "./settings-ui.js";
import settingsSetup from "./settings-ui.mjs?raw";
import serverSetup from "./server.ts?raw";
import { generateWorkflowManagementHtml } from "./workflows-ui.js";

describe("settings UI", () => {
  it("provides token, notifications, and worker settings without a duplicate workflows link", () => {
    const source = generateSettingsHtml() + settingsSetup;
    expect(source).toContain("/api/api-keys");
    expect(source).toContain("New API key");
    expect(source).toContain("Generate API key");
    expect(source).toContain("workflows:write");
    expect(source).toContain("Notifications");
    expect(source).toContain("Workers");
    expect(source).toContain('href="#section-workers"');
    expect(source).toContain('id="section-keys"');
    expect(source).toContain('id="section-notifications"');
    expect(source).toContain('class="sticky top-0 z-20');
    expect(source).not.toContain("-mx-1");
    expect(source).toContain("{{ scope.label }}");
    expect(source).not.toContain("{{\n                      scope.label");
    expect(source).not.toContain('href="/settings/workflows"');
    expect(source).toContain('ref="apiKeyForm"');
    expect(source).toContain("key.token");
    expect(source).toContain("apiKeyForm.value.open = false");
    expect(settingsSetup).toContain("revealedKeys.get(key.id)");
    expect(settingsSetup).toContain("isNew: true");
    expect(source).toContain("bg-white");
    expect(source).not.toContain("bg-gray-950");
    expect(source).not.toContain("<app-header");
  });

  it("loads and saves the user's timezone and formats worker/key timestamps", () => {
    const html = generateSettingsHtml() + settingsSetup;
    expect(settingsSetup).toContain("/api/preferences");
    expect(settingsSetup).toContain('method: "PUT"');
    expect(settingsSetup).toContain("Intl.DateTimeFormat");
    expect(html).toContain('type="text"');
    expect(html).toContain('list="timezone-options"');
    expect(html).toContain('<datalist id="timezone-options">');
    expect(html).not.toContain("<select");
    expect(settingsSetup).toContain("new Intl.DateTimeFormat(undefined, { timeZone: selectedTimezone })");
    expect(settingsSetup).toContain("timezone.value = saved.timezone");
    expect(settingsSetup).not.toContain("setApiToken");
    expect(settingsSetup).toContain('new Date(text.includes("T") ? text : `${text.replace(" ", "T")}Z`)');
    expect(html).toContain("formatTimestamp(worker.lastSeen)");
    expect(html).toContain("formatTimestamp(key.created_at)");
    expect(html).toContain('attr-title="worker.workerId"');
    const secrets = generateWorkflowManagementHtml("secrets");
    expect(secrets).toContain("grid-cols-[minmax(0,1fr)_2rem]");
    expect(secrets).toContain("grid-cols-[2rem_minmax(0,1fr)_auto_1rem]");
  });

  it("hides worker and user sections when access is forbidden", () => {
    const html = generateSettingsHtml() + settingsSetup;
    expect(html).toContain("/api/users");
    expect(html).toContain("/role");
    expect(html).toContain("confirm(");
    expect(html).toContain("usersForbidden");
    expect(html).toContain("workersLoaded.value = true");
    expect(html).toContain("usersLoaded.value = true");
    expect(html.match(/class-hidden="!workersLoaded \|\| workersForbidden"/g)).toHaveLength(2);
    expect(html.match(/class-hidden="!usersLoaded \|\| usersForbidden"/g)).toHaveLength(2);
    expect(html).not.toContain("administrators only");
    expect(html).not.toContain("does not have permission to view worker status");
  });

  it("keeps the unified settings document independent of legacy route parameters", () => {
    expect(generateSettingsHtml()).toContain('data-page="settings"');
    expect(serverSetup).not.toContain('rawPage === "workers"');
    expect(serverSetup).toContain("generateSettingsHtml()");
  });

  it("exposes secrets on the unified settings page with anchored deep links", () => {
    const html = generateSettingsHtml();
    for (const section of ["timezone", "keys", "notifications", "workers", "users", "secrets"]) {
      expect(html).toContain(`id="section-${section}"`);
      expect(html).toContain(`href="#section-${section}"`);
    }
    expect(html).toContain('id="secret-value"');
    expect(html).toContain('id="secret-file"');
    expect(html).not.toContain('aria-label="Secret count"');
    expect(html).not.toContain("<app-header");
    expect(settingsSetup).toContain('const secretForm = templateRef("secretForm")');
    expect(settingsSetup).toContain("secretForm.value.open = true");
    expect(settingsSetup).toContain('scrollIntoView({ behavior: "smooth", block: "center" })');
    expect(settingsSetup).toContain("secretValueInput.value?.focus({ preventScroll: true })");
    expect(html).toContain("attr-aria-label=\"'Delete secret ' + name\"");
    expect(settingsSetup).toContain("loadWorkers()");
    expect(settingsSetup).toContain("workersForbidden.value = true");
    expect(settingsSetup).toContain("loadUsers()");
    expect(settingsSetup).toContain('api("/api/secrets")');
    expect(settingsSetup).toContain('method: "PUT"');
    expect(settingsSetup).toContain('method: "DELETE"');
    expect(settingsSetup).toContain('encoding: "base64"');
  });

  it("keeps team APIs out of general settings", () => {
    expect(generateSettingsHtml()).not.toContain("section-teams");
    expect(settingsSetup).not.toContain("/api/teams");
  });
});
