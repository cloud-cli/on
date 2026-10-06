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

  it("maps all settings sub-pages to their respective components", () => {
    expect(routerSetup).not.toContain("path === '/settings/workflows'");
    expect(routerSetup).toContain('path === "/settings/secrets"');
    expect(routerSetup).toContain('path === "/settings/tokens"');
    expect(routerSetup).toContain('path === "/settings/notifications"');
    expect(routerSetup).toContain('path === "/settings/workers"');
    expect(routerSetup).toContain('path === "/settings"');

    expect(routerSetup).toContain('url: "/pages/workflows.html?page=workflows"');
    expect(routerSetup).toContain('url: "/pages/workflows.html?page=secrets"');
    expect(routerSetup).toContain('url: "/pages/settings.html?page=tokens"');
    expect(routerSetup).toContain('url: "/pages/settings.html?page=notifications"');
    expect(routerSetup).toContain('url: "/pages/settings.html?page=workers"');
  });

  it("SPA handleClick intercepts same-origin navigation excluding /auth/, /api/, /webhooks", () => {
    expect(handleClick).toContain('target.pathname.startsWith("/auth/")');
    expect(handleClick).toContain('target.pathname.startsWith("/api/")');
    expect(handleClick).toContain('target.pathname.startsWith("/webhooks/")');
    expect(handleClick).toContain("event.preventDefault()");
    expect(handleClick).toContain("history.pushState");
  });

  it("routes /settings to settings and /workflows to workflow management", () => {
    expect(routerSetup).toContain('if (path === "/settings")');
    expect(routerSetup).toContain('if (path === "/workflows")');
    expect(routerSetup).toContain('url: "/pages/settings.html?page=tokens"');
    expect(routerSetup).toContain('url: "/pages/workflows.html?page=workflows"');
    expect(serverSetup).toContain("Location: destination");
    expect(serverSetup).toContain("return this.renderAppShell(res);");
  });

  it("route mapping covers settings tabs and workflow editor paths only under /workflows", () => {
    expect(routerSetup).toContain('path === "/settings/secrets"');
    expect(routerSetup).toContain('path === "/settings/tokens"');
    expect(routerSetup).toContain('path === "/settings/notifications"');
    expect(routerSetup).toContain('path === "/settings/workers"');
    expect(routerSetup).toContain('path === "/settings"');

    expect(routerSetup).not.toContain("path.match(/^\\/settings\\/workflows\\/(new|[a-z0-9-]+)$/)");
    expect(routerSetup).toContain("path.match(/^\\/workflows\\/(new|[a-z0-9-]+)$/)");
  });

  it("shows a not-found view rather than falling back to the dashboard for unknown routes", () => {
    expect(routerSetup).toContain('component: "page-not-found", page: "not-found"');
    expect(routerSetup).toContain('if (current.page === "not-found")');
  });
});
