import { describe, expect, it } from "vitest";
import routerTemplate from "../ui/app-router.html?raw";
import routerSetup from "../ui/app-router.mjs?raw";
import serverSetup from "./server.ts?raw";
import appShell from "../ui/app-shell.html?raw";

const handleClick = routerSetup.match(/const handleClick = \(event\) => \{([\s\S]*?)\n  \};/)?.[1] ?? "";

describe("SPA router", () => {
  it("keeps workflow editor routes under /workflows rather than Settings", () => {
    expect(routerTemplate).toContain('<script setup src="/assets/app-router.mjs"></script>');
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
    expect(routerSetup).toContain('path === "/teams" || path === "/workspaces"');
    expect(routerSetup).not.toContain("settingsSections");
    expect(routerSetup).not.toMatch(/path === "\/settings\/|path\.startsWith\("\/settings\//);
    expect(routerSetup).toContain('url: "/assets/pages/workflows.html?page=workflows"');
    expect(routerSetup).toContain('url: "/assets/pages/settings.html"');
  });

  it("SPA handleClick intercepts same-origin navigation excluding API and assets", () => {
    expect(handleClick).toContain('target.pathname.startsWith("/auth/")');
    expect(handleClick).toContain('target.pathname.startsWith("/api/v1/")');
    expect(handleClick).toContain('target.pathname.startsWith("/assets/")');
    expect(handleClick).toContain("event.preventDefault()");
    expect(handleClick).toContain("history.pushState");
  });

  it("routes /settings to settings and /workflows to workflow management", () => {
    expect(routerSetup).toContain('if (path === "/settings")');
    expect(routerSetup).toContain('if (path === "/workflows")');
    expect(routerSetup).toContain('page: "settings"');
    expect(routerSetup).toContain('url: "/assets/pages/workflows.html?page=workflows"');
    expect(serverSetup).toContain("Location: destination");
    expect(serverSetup).not.toContain("settingsPageMatch");
    expect(serverSetup).toContain("return this.renderAppShell(res);");
  });

  it("routes global recipes independently of workspace selection", () => {
    expect(routerSetup).toContain('if (path === "/recipes")');
    expect(routerSetup).toContain('if (path === "/recipes/new")');
    expect(routerSetup).toContain('url: "/assets/pages/recipes.html"');
    expect(routerSetup).toContain(
      'current.page === "recipes" || current.page === "recipe-editor" ? [] : await checkTeams()',
    );
    expect(appShell).toContain('href="/ui/recipes"');
    expect(serverSetup).toContain('url.pathname === "/pages/recipes.html"');
  });

  it("routes run detail URLs through the app shell and loads the run component on refresh", () => {
    expect(routerSetup).toContain('component: "page-run"');
    expect(routerSetup).toContain('url: `/assets/pages/run.html?jobId=${path.split("/").pop()}`');
    expect(routerSetup).toContain('url.searchParams.get("workspaceId")');
    expect(serverSetup).toContain('if (req.method === "GET" && /^\\/runs\\/\\d+$/.test(url.pathname))');
    expect(serverSetup).toContain("return this.renderAppShell(res);");
    expect(serverSetup).toContain('if (req.method === "GET" && url.pathname.startsWith("/api/runs/"))');
    expect(handleClick).toContain('target.pathname.startsWith("/api/v1/")');
  });

  it("keeps invocation details workspace-scoped and mounts a separate invocation view", () => {
    expect(routerSetup).toContain("path.match(/^\\/workspaces\\/([^/]+)\\/invocations\\/([^/]+)$/)");
    expect(routerSetup).toContain('component: "page-invocation"');
    expect(routerSetup).toContain("mountInvocation(component)");
    expect(serverSetup).toContain("/^\\/workspaces\\/[^/]+\\/invocations\\/[^/]+$/");
  });

  it("serves workspace run routes directly so refreshes load the app shell", () => {
    expect(routerSetup).toContain("path.match(/^\\/workspaces\\/([^/]+)\\/runs$/)");
    expect(serverSetup).toContain("/^\\/workspaces\\/[^/]+\\/runs(?:\\/events)?$/");
    expect(serverSetup).toContain("return this.renderAppShell(res);");
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

  it("keeps the shell usable and offers retry when workspace or page loading fails", () => {
    expect(routerSetup).toContain("AbortSignal.timeout(15_000)");
    expect(routerSetup).toContain('routeMessage.textContent = "Loading your workspace…"');
    expect(routerSetup).toContain('document.body.dataset.teamless = "false";');
    expect(routerSetup).toContain('routeMessage.setAttribute("role", "alert")');
    expect(routerSetup).toContain('heading.textContent = "This page could not load"');
    expect(routerSetup).toContain('retry.textContent = "Try again"');
    expect(routerSetup).toContain("void navigate(true)");
    expect(routerSetup).toContain("bg-app-card");
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

  it("mounts run details and editors as disposable route components", () => {
    expect(routerSetup).toMatch(/const persistentPage = !\[[\s\S]*"workflows",[\s\S]*"incoming-events"/);
    expect(routerSetup).toContain("activeTransientPage?.remove()");
  });

  it("checks team membership before mounting app routes and offers focused first-team onboarding", () => {
    expect(appShell).toContain('data-teamless="checking"');
    expect(routerSetup).toContain('apiFetch("/api/v1/workspaces"');
    expect(routerSetup).toContain(
      'if (!teams.length && current.page !== "recipes" && current.page !== "recipe-editor")',
    );
    expect(routerSetup).toContain("showOnboarding()");
    expect(routerSetup).toContain('apiFetch("/api/v1/workspaces", {');
    expect(routerSetup).toContain('localStorage.setItem("runner-team-id", team.id)');
    expect(routerSetup).toContain("let teamCreated = false");
    expect(routerSetup).toContain("Your workspace was created, but this browser could not save the selection");
    expect(routerSetup).toContain('document.body.dataset.teamless = "true"');
    expect(routerSetup).toContain("Continue");
    expect(routerTemplate).toContain('ref="outlet"');
  });

  it("routes team settings through membership validation and scopes the selected team", () => {
    expect(routerSetup).toContain("path.match(/^\\/(?:teams|workspaces)\\/([^/]+)\\/settings$/)");
    expect(routerSetup).toContain("teams.some((team) => team.id === current.teamId)");
    expect(routerSetup).toContain('localStorage.setItem("runner-team-id", current.teamId)');
    expect(routerSetup).toContain(
      "url: `/assets/pages/team-settings.html?teamId=${encodeURIComponent(teamSettings[1])}`",
    );
    expect(serverSetup).toContain('url.pathname === "/pages/team-settings.html"');
    expect(serverSetup).toContain('url.pathname === "/team-settings-ui.mjs"');
    expect(serverSetup).toContain("^\\/(?:teams|workspaces)\\/[^/]+\\/settings$");
  });
  it("routes workspace recent runs and scopes workflow editors from their workspace query", () => {
    expect(routerSetup).toContain("path.match(/^\\/workspaces\\/([^/]+)\\/runs$/)");
    expect(routerSetup).toMatch(/page: "dashboard",\s+teamId: decodeURIComponent\(teamRuns\[1\]\)/);
    expect(routerSetup).toContain('teamId: url.searchParams.get("workspaceId") || ""');
    expect(routerSetup).toContain('localStorage.setItem("runner-team-id", current.teamId)');
  });
  it("routes the team landing page through authenticated server delivery", () => {
    expect(routerSetup).toContain('path === "/teams" || path === "/workspaces"');
    expect(routerSetup).toContain('url: "/assets/pages/workspaces.html"');
    expect(serverSetup).toContain('"/pages/workspaces.html"');
    expect(serverSetup).toContain('"/workspaces"');
  });
});
