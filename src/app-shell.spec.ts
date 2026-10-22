import { readdirSync, readFileSync } from "node:fs";
import { describe, expect, it, vi } from "vitest";
import { WebhookServer } from "./server.js";
import shellSetup from "../ui/app-shell.mjs?raw";
import preferencesSetup from "../ui/preferences.mjs?raw";

const html = readFileSync(new URL("../ui/app-shell.html", import.meta.url), "utf8");

describe("On application shell", () => {
  it("uses compact vertical spacing on every page main", () => {
    for (const directory of ["ui", "src"]) {
      const files = readdirSync(new URL(`../${directory}/`, import.meta.url)).filter((file) => file.endsWith(".html"));
      for (const file of files) {
        const source = readFileSync(new URL(`../${directory}/${file}`, import.meta.url), "utf8");
        expect(source, `${directory}/${file}`).not.toMatch(/<main\b[^>]*\bpy-6\b/);
      }
    }
  });

  it("provides responsive, accessible navigation around the mounted router", () => {
    expect(shellSetup).toContain('import "@app/api-client.mjs"');
    expect(shellSetup).toContain('"workspace-workflows" : "workspace-runs"');
    expect(shellSetup).toContain('addEventListener("runner-route-changed", syncSection)');
    expect(html).toContain('"@app/": "/assets/"');
    expect(html).toContain('"yaml": "https://esm.sh/yaml@2.9.0"');
    expect(html).toContain('aria-label="Primary navigation"');
    expect(html).toContain("data-mobile-menu-button");
    expect(html).toContain('aria-controls="primary-sidebar"');
    expect(html).toContain('aria-label="Close navigation menu"');
    expect(html).not.toContain('href="/ui/runs"');
    expect(html).toContain('href="/ui/recipes"');
    expect(html).not.toContain('href="/ui/workflows"');
    expect(html).toContain('href="/ui/settings"');
    expect(html.match(/href="\/ui\/workspaces"/g)).toHaveLength(2);
    expect(html).toContain('href="/ui/settings"');
    expect(html).toContain("focus-visible:ring-2");
    expect(html).toContain('>on<span class="text-[#729b5b]">:</span>');
    expect(html).toContain("w-[27px] rounded-[2px] bg-[#547d42]");
    expect(html).toContain('href="#main-content"');
    expect(html).toContain("data-skip-to-content");
    expect(html).toContain('id="main-content"');
    expect(html).toContain('tabindex="-1"');
    expect(html).toContain('class="min-h-dvh bg-app-background');
    expect(html).toContain("min-h-dvh md:grid md:grid-cols-[16rem_minmax(0,1fr)]");
    expect(html).toContain("fixed inset-y-0 left-0 z-50");
    expect(html).toContain("md:sticky md:z-auto");
    expect(html).not.toContain("overscroll-y-contain");
    expect(html).not.toContain("overflow-hidden bg-app-background");
    expect(html).toContain('href="/ui/settings"');
    expect(html).toContain("Open preferences for ");
    expect(html).toContain("max-w-[calc(100vw-4rem)]");
    expect(html).toContain("max-w-[calc(100vw-7rem)]");
    expect(html).toContain('class="hidden min-w-0 max-w-[calc(100vw-7rem)] flex-col');
    expect(html).toContain("sm:flex sm:max-w-none");
    expect(html).toContain('class="truncate text-sm font-semibold leading-tight"');
    expect(html).toContain('class="truncate text-[10px] leading-tight text-app-secondary"');
    expect(html).toContain('on-click="toggleTheme()"');
    expect(html).toContain('class="flex items-center gap-2 px-4 pt-4 sm:gap-4 sm:px-6 lg:px-8"');
    expect(html).toContain('class="ml-auto flex shrink-0 items-center gap-2 sm:gap-4"');
    expect(html).toContain("flex h-dvh w-72");
    expect(html).toContain("isDarkTheme ? 'sun' : 'moon'");
    expect(html).toContain("isDarkTheme ? 'Switch to light mode' : 'Switch to dark mode'");
    expect(shellSetup).toContain('setAuthPreference("theme", nextTheme)');
    expect(shellSetup).toContain('themeMedia.addEventListener("change", syncSystemTheme)');
    expect(html).toContain('attr-src="user.photo || user.picture || null"');
    expect(html).toContain("aria-[current=page]:font-semibold");
    expect(html).not.toContain('<main class="min-h-screen min-w-0');
    expect(html).toContain("<app-router></app-router>");
    expect(html).not.toContain("Workers</a>");
    expect(html).not.toContain("Engineering");
    expect(html).not.toContain("JD");
    expect(html).not.toContain("min-h-screen border-r border-app-border");
    expect(html.indexOf("Workspaces</a")).toBeLessThan(html.indexOf("Your workspaces"));
    expect(html.indexOf("Recipes</a")).toBeLessThan(html.indexOf("Your workspaces"));
    expect(html).toContain("Workspace navigation");
    expect(html).not.toContain("mt-auto");
  });

  it("loads the signed-in profile from the session endpoint without inventing a user", () => {
    expect(shellSetup).toContain('fetch("/api/v1/auth/session"');
    expect(shellSetup).toContain("session?.authenticated || !session.user");
    expect(html).toContain("user.name || user.email");
    expect(html).toContain("{{ user.email }}");
    expect(html).not.toContain('target="_blank"');
    expect(html).not.toContain("oidcProviderUrl");
    expect(html).toContain('if="userAuthenticated"');
  });

  it("lists workspaces in the sidebar and links each workspace to its settings page", () => {
    const teamsList = html.indexOf('aria-label="Workspace navigation"');

    expect(teamsList).toBeGreaterThan(html.indexOf('aria-label="Primary navigation"'));
    expect(teamsList).toBeLessThan(html.indexOf('id="main-content"'));
    expect(html).toContain("# {{ team.name }}");
    expect(html).toContain("workspacePath(team.id, 'runs')");
    expect(html).toContain('on-click="selectWorkspace(team.id)"');
    expect(html).toContain('attr-data-workspace-nav-item="team.id"');
    expect(html).toContain("data-workspace-submenu");
    expect(html).toContain('class-hidden="selectedWorkspaceId !== team.id"');
    expect(shellSetup).toContain('submenu?.classList.toggle("hidden", !selected)');
    expect(shellSetup).toContain("const syncWorkspaceNavigation = () =>");
    expect(shellSetup).toContain('const selectedWorkspaceId = ref("")');
    expect(shellSetup).toContain("selectedWorkspaceId.value = decodeURIComponent(workspaceRoute[1])");
    expect(shellSetup).toContain("teams.value.some((team) => team.id === storedWorkspaceId)");
    expect(shellSetup).toContain('selectedWorkspaceId.value = event.detail?.teamId || ""');
    expect(shellSetup).toContain('fetch("/api/v1/workspaces"');
    expect(shellSetup).toContain('addEventListener("runner-teams-updated", loadTeams)');
    expect(shellSetup).toContain('path.startsWith("/workspaces/")');
    expect(html).toContain(">Your workspaces</p>");
    expect(html).toContain("px-3 py-2.5 text-sm text-app-secondary");
    expect(html).toContain("selectedWorkspaceId === team.id");
    expect(html).toContain("workspacePath(team.id, 'workflows')");
  });

  it("handles Enter and Space on the skip link without triggering browser navigation", () => {
    expect(shellSetup).toContain('["Enter", " "].includes(event.key)');
    expect(shellSetup).toContain("event.preventDefault()");
    expect(shellSetup).toContain('getElementById("main-content")');
    expect(shellSetup).toContain('addEventListener("keydown", handleSkipKeydown)');
    expect(shellSetup).toContain('removeEventListener("keydown", handleSkipKeydown)');
  });

  it("serves the shell setup module referenced by the app shell", async () => {
    expect(html).toContain('<script setup src="/assets/app-shell.mjs"></script>');
    expect(shellSetup).toContain('from "@app/preferences.mjs"');
    const response = { writeHead: vi.fn().mockReturnThis(), end: vi.fn() };

    await (WebhookServer.prototype as any).handleRequest.call(
      {},
      { method: "GET", url: "/assets/app-shell.mjs", headers: { host: "app.test" } },
      response,
    );

    expect(response.writeHead).toHaveBeenCalledWith(200, {
      "Cache-Control": "no-cache",
      "Content-Type": "text/javascript; charset=utf-8",
    });
    expect(response.end).toHaveBeenCalledWith(shellSetup);
  });

  it("serves the shared user-preferences module used by browser pages", async () => {
    const response = { writeHead: vi.fn().mockReturnThis(), end: vi.fn() };

    await (WebhookServer.prototype as any).handleRequest.call(
      {},
      { method: "GET", url: "/assets/preferences.mjs", headers: { host: "app.test" } },
      response,
    );

    expect(response.writeHead).toHaveBeenCalledWith(200, {
      "Cache-Control": "no-cache",
      "Content-Type": "text/javascript; charset=utf-8",
    });
    expect(response.end).toHaveBeenCalledWith(preferencesSetup);
  });
});
