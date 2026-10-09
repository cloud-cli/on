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

  it("uses /settings as the sole settings route and section anchors for navigation", () => {
    expect(routerSetup).toContain('if (path === "/settings")');
    expect(routerSetup).not.toContain("settingsSections");
    expect(routerSetup).not.toMatch(/path === "\/settings\/|path\.startsWith\("\/settings\//);
    expect(routerSetup).toContain('url: "/pages/workflows.html?page=workflows"');
    expect(routerSetup).toContain('url: "/pages/settings.html"');
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
    expect(routerSetup).toContain('page: "settings"');
    expect(routerSetup).toContain('url: "/pages/workflows.html?page=workflows"');
    expect(serverSetup).toContain("Location: destination");
    expect(serverSetup).not.toContain("settingsPageMatch");
    expect(serverSetup).toContain("return this.renderAppShell(res);");
  });

  it("routes run detail URLs through the app shell and loads the run component on refresh", () => {
    expect(routerSetup).toContain('component: "page-run", url: `/pages/run.html?jobId=${path.split("/").pop()}`');
    expect(serverSetup).toContain('if (req.method === "GET" && /^\\/runs\\/\\d+$/.test(url.pathname))');
    expect(serverSetup).toContain("return this.renderAppShell(res);");
    expect(serverSetup).toContain('if (req.method === "GET" && url.pathname.startsWith("/api/runs/"))');
    expect(handleClick).toContain('target.pathname.startsWith("/api/")');
  });

  it("route mapping covers /settings and workflow editor paths only under /workflows", () => {
    expect(routerSetup).toContain('path === "/settings"');

    expect(routerSetup).not.toContain("path.match(/^\\/settings\\/workflows\\/(new|[a-z0-9-]+)$/)");
    expect(routerSetup).toContain("path.match(/^\\/workflows\\/(new|[a-z0-9-]+)$/)");
  });

  it("shows a not-found view rather than falling back to the dashboard for unknown routes", () => {
    expect(routerSetup).toContain('component: "page-not-found", page: "not-found"');
    expect(routerSetup).toContain('if (current.page === "not-found")');
  });

  it("keeps mounted page instances alive and only loads each primary page on first visit", () => {
    expect(routerSetup).toContain("const mountedPages = new Map()");
    expect(routerSetup).toContain("mountedPages.get(cacheKey)");
    expect(routerSetup).toContain("page.hidden = page !== component");
    expect(routerSetup).toContain("outlet.value.append(component)");
    expect(routerSetup).not.toContain("outlet.value.replaceChildren(document.createElement(current.component))");
  });

  it("delegates same-origin link navigation across the whole shell", () => {
    expect(routerSetup).toContain('document.addEventListener("click", handleClick)');
    expect(routerSetup).toContain('document.removeEventListener("click", handleClick)');
  });

  it("uses history navigation for app actions instead of reloading the document", () => {
    expect(routerSetup).toContain("export function navigateTo(path)");
    expect(routerSetup).toContain('history.pushState(null, "", path)');
    expect(routerSetup).toContain('window.dispatchEvent(new PopStateEvent("popstate"))');
    expect(routerSetup).toContain("const handlePopState = () => void navigate()");
    expect(routerSetup).not.toContain("location.reload()");
  });

  it("mounts run details and workflow editors as disposable route components", () => {
    expect(routerSetup).toContain('!["run", "editor"].includes(current.page)');
    expect(routerSetup).toContain("activeTransientPage?.remove()");
  });
});
