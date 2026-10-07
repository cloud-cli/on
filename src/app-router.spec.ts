import { describe, expect, it } from "vitest";
import routerTemplate from "./app-router.html?raw";
import routerSetup from "./app-router.mjs?raw";
import serverSetup from "./server.ts?raw";

const handleClick = routerSetup.match(/const handleClick = \(event\) => \{([\s\S]*?)\n  \};/)?.[1] ?? "";

describe("SPA router", () => {
  it("keeps workflow editor routes under /workflows rather than Settings", () => {
    expect(routerTemplate).toContain('<script setup src="/app-router.mjs"></script>');
    expect(routerSetup).toContain("path.match(/^\\/workflows\\/(new|[a-z0-9-]+)$/)");
    expect(handleClick).toContain("event.preventDefault()");
    expect(handleClick).toContain("history.pushState");
    expect(handleClick).not.toMatch(/target\.pathname === '\/settings'|target\.pathname\.startsWith\('\/settings\/'\)/);
    expect(handleClick).not.toMatch(
      /target\.pathname === '\/workflows'|target\.pathname\.startsWith\('\/workflows\/'\)/,
    );
  });

  it("maps legacy settings deep links to unified in-page sections", () => {
    expect(routerSetup).not.toContain("path === '/settings/workflows'");
    expect(routerSetup).toContain('"/settings/secrets": "secrets"');
    expect(routerSetup).toContain('"/settings/tokens": "keys"');
    expect(routerSetup).toContain('"/settings/notifications": "notifications"');
    expect(routerSetup).toContain('"/settings/workers": "workers"');
    expect(routerSetup).toContain('"/settings/timezone": "timezone"');
    expect(routerSetup).toContain('"/settings/secrets": "secrets"');
    expect(routerSetup).toContain('path === "/settings" || settingsSections[path]');

    expect(routerSetup).toContain('url: "/pages/workflows.html?page=workflows"');
    expect(routerSetup).toContain('"/settings/tokens": "keys"');
    expect(routerSetup).toContain(
      '`/pages/settings.html?page=settings${path === "/settings" ? "" : `#section-${section}`}`',
    );
  });

  it("SPA handleClick intercepts same-origin navigation excluding /auth/, /api/, /webhooks", () => {
    expect(handleClick).toContain('target.pathname.startsWith("/auth/")');
    expect(handleClick).toContain('target.pathname.startsWith("/api/")');
    expect(handleClick).toContain('target.pathname.startsWith("/webhooks/")');
    expect(handleClick).toContain("event.preventDefault()");
    expect(handleClick).toContain("history.pushState");
  });

  it("routes /settings to settings and /workflows to workflow management", () => {
    expect(routerSetup).toContain('path === "/settings" || settingsSections[path]');
    expect(routerSetup).toContain('if (path === "/workflows")');
    expect(routerSetup).toContain('page: "settings"');
    expect(routerSetup).toContain('url: "/pages/workflows.html?page=workflows"');
    expect(serverSetup).toContain("Location: destination");
    expect(serverSetup).toContain("secrets|tokens|notifications|workers|timezone");
    expect(serverSetup).toContain("return this.renderAppShell(res);");
  });

  it("route mapping covers settings tabs and workflow editor paths only under /workflows", () => {
    expect(routerSetup).toContain('"/settings/secrets": "secrets"');
    expect(routerSetup).toContain('"/settings/tokens": "keys"');
    expect(routerSetup).toContain('path === "/settings"');

    expect(routerSetup).not.toContain("path.match(/^\\/settings\\/workflows\\/(new|[a-z0-9-]+)$/)");
    expect(routerSetup).toContain("path.match(/^\\/workflows\\/(new|[a-z0-9-]+)$/)");
  });

  it("shows a not-found view rather than falling back to the dashboard for unknown routes", () => {
    expect(routerSetup).toContain('component: "page-not-found", page: "not-found"');
    expect(routerSetup).toContain('if (current.page === "not-found")');
  });
});
