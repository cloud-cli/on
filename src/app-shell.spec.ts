import { readdirSync, readFileSync } from "node:fs";
import { describe, expect, it, vi } from "vitest";
import { WebhookServer } from "./server.js";
import shellSetup from "../ui/app-shell.mjs?raw";
import preferencesSetup from "../ui/preferences.mjs?raw";

const html = readFileSync(new URL("../ui/app-shell.html", import.meta.url), "utf8");
const styles = readFileSync(new URL("../ui/index.css", import.meta.url), "utf8");

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
    expect(shellSetup).toContain('import { apiFetch } from "@app/api-client.mjs"');
    expect(shellSetup).toContain('page === "channels" ? "channels"');
    expect(shellSetup).toContain('page === "workflows" ? "workflows"');
    expect(shellSetup).toContain('addEventListener("runner-route-changed", syncSection)');
    expect(html).toContain('"@app/": "/assets/"');
    expect(html).toContain('"yaml": "https://esm.sh/yaml@2.9.0"');
    expect(html).toContain('aria-label="Primary navigation"');
    expect(html).toContain("data-workspace-rail");
    expect(html).toContain('aria-label="Workspace switcher"');
    expect(html).toContain("attr-aria-pressed=\"team.isSelected ? 'true' : 'false'\"");
    expect(html).not.toContain('href="/ui/runs"');
    expect(html).toContain('href="/ui/recipes"');
    expect(html).not.toContain('href="/ui/workflows"');
    expect(html).toContain('href="/ui/settings"');
    expect(html.match(/href="\/ui\/workspaces"/g)).toHaveLength(2);
    expect(html).toContain('href="/ui/settings"');
    expect(html).toContain("focus-visible:ring-2");
    expect(html).toContain('aria-label="dimon home"');
    expect(html).toContain("<title>dimon · Runs</title>");
    expect(html).toContain("w-[27px] rounded-[2px] bg-[#547d42]");
    expect(html).toContain('href="#main-content"');
    expect(html).toContain("data-skip-to-content");
    expect(html).toContain('id="main-content"');
    expect(html).toContain('tabindex="-1"');
    expect(html).toContain('class="min-h-dvh bg-app-background');
    expect(html).toContain("grid-cols-[4rem_14rem_minmax(0,1fr)]");
    expect(html).toContain("md:w-56");
    expect(html).toContain("md:sticky md:top-0");
    expect(html).not.toContain("overscroll-y-contain");
    expect(html).not.toContain("overflow-hidden bg-app-background");
    expect(html).toContain('href="/ui/settings"');
    expect(html).toContain('aria-label="Open preferences"');
    expect(html).toContain(
      'class="user-avatar relative grid size-10 shrink-0 place-items-center overflow-hidden rounded-lg',
    );
    expect(html).toContain('class="user-card mt-auto flex w-full flex-col items-center gap-2 pt-3"');
    expect(html).not.toContain("user.name || user.email");
    expect(html).toContain("{{ user.email }}");
    expect(html).toContain('on-click="toggleTheme()"');
    expect(html).toContain('class="flex items-center gap-2 px-2 py-1 sm:gap-4 sm:px-3 md:px-4"');
    expect(html).not.toContain('class="ml-auto flex shrink-0 items-center gap-2 sm:gap-4"');
    expect(html).toContain("md:h-dvh md:w-56");
    expect(html).toContain("isDarkTheme ? 'sun' : 'moon'");
    expect(html).toContain("isDarkTheme ? 'Switch to light mode' : 'Switch to dark mode'");
    expect(shellSetup).toContain('setAuthPreference("theme", nextTheme)');
    expect(shellSetup).toContain('themeMedia.addEventListener("change", syncSystemTheme)');
    expect(shellSetup).toContain("requestAnimationFrame(() => {");
    expect(shellSetup).toContain('document.querySelector("[data-quick-switch-search]")?.focus()');
    expect(html).toContain('<template if="user.photo || user.picture"');
    expect(html).toContain('attr-src="user.photo || user.picture"');
    expect(html).not.toContain("user.photo || user.picture || null");
    expect(html).toContain("aria-[current=page]:font-semibold");
    expect(html).not.toContain('<main class="min-h-screen min-w-0');
    expect(html).toContain("<app-router></app-router>");
    expect(html).not.toContain("Workers</a>");
    expect(html).not.toContain("Engineering");
    expect(html).not.toContain("JD");
    expect(html).not.toContain("min-h-screen border-r border-app-border");
    expect(html).toContain('aria-label="Global navigation"');
    expect(html).toContain('aria-label="Workspace navigation"');
    expect(html).toContain('class="col-start-2 row-start-1');
    expect(html).toContain("md:col-start-3 md:row-start-1 md:p-4");
    expect(html).not.toContain("data-mobile-menu-button");
    expect(html).not.toContain("data-workspace-nav-item");
    expect(html).not.toContain("data-workspace-submenu");
    expect(html).toContain("mt-auto");
  });

  it("loads the signed-in profile from the session endpoint without inventing a user", () => {
    expect(shellSetup).toContain('fetch("/api/v1/auth/session"');
    expect(shellSetup).toContain("session?.authenticated || !session.user");
    expect(html).not.toContain("user.name || user.email");
    expect(html).toContain("{{ user.email }}");
    expect(html).not.toContain('target="_blank"');
    expect(html).not.toContain("oidcProviderUrl");
    expect(html).toContain('if="userAuthenticated"');
  });

  it("keeps workspace switching in the left rail and shows only selected-workspace navigation", () => {
    const rail = html.indexOf("data-workspace-rail");
    const navigation = html.indexOf('aria-label="Primary navigation"');
    const content = html.indexOf('id="main-content"');

    expect(rail).toBeLessThan(navigation);
    expect(navigation).toBeLessThan(content);
    expect(html).toContain('attr-data-workspace-switch="team.id"');
    expect(html).toContain('popover="manual"');
    expect(html).toContain('attr-data-workspace-popover="team.id"');
    expect(html).toContain('on-pointerenter="showWorkspacePopover(team.name, $event.currentTarget)"');
    expect(html).toContain('on-focus="showWorkspacePopover(team.name, $event.currentTarget)"');
    expect(shellSetup).toContain("button.getBoundingClientRect()");
    expect(shellSetup).toContain("popover.showPopover()");
    expect(shellSetup).toContain("showWorkspacePopover,");
    expect(shellSetup).toContain("hideWorkspacePopover,");
    expect(html).toContain('<template if="team.isSelected"');
    expect(html).toContain("workspacePath(team.id, 'runs')");
    expect(html).toContain("workspacePath(team.id, 'workflows')");
    expect(html).toContain('for="channel of workspaceChannels"');
    expect(html).toContain("workspacePath(team.id, 'channels') + '/' + encodeURIComponent(channel.id)");
    expect(shellSetup).toContain('apiFetch("/api/v1/streams"');
    expect(shellSetup).toContain('"X-Team-ID": workspaceId');
    expect(shellSetup).toContain("result.streams || []");
    expect(shellSetup).toContain("channelsStatus");
    expect(shellSetup).toContain("channelsEmpty.value = workspaceChannels.value.length === 0");
    expect(html).toContain('if="channelsEmpty"');
    expect(html).toContain("Create your first Stream</a");
    expect(html).toContain("attr-href=\"workspacePath(team.id, 'channels')\"");
    expect(html).toContain('if="channelsStatus"');
    expect(shellSetup).not.toContain("No channels in this workspace yet.");
    expect(html).toContain("on-click=\"selectWorkspace(team.id, 'runs')\"");
    expect(shellSetup).toContain('const selectedWorkspaceId = ref("")');
    expect(shellSetup).toContain("setSelectedWorkspace(decodeURIComponent(workspaceRoute[1]))");
    expect(shellSetup).toContain("availableTeams.some((team) => team.id === storedWorkspaceId)");
    expect(shellSetup).toContain("const syncWorkspace = () => syncSection()");
    expect(shellSetup).toContain('fetch("/api/v1/workspaces"');
    expect(shellSetup).toContain('addEventListener("runner-teams-updated", loadTeams)');
    expect(shellSetup).toContain('path.startsWith("/workspaces/")');
    expect(shellSetup).not.toContain("syncWorkspaceNavigation");
    expect(html).toContain("flex min-w-0 flex-wrap items-center gap-1 md:mt-1 md:flex-col md:flex-nowrap");
    expect(html).toContain("md:flex-col md:flex-nowrap md:items-stretch");
    expect(html).toContain("team.isSelected");
    expect(html).toContain('aria-label="Switch workspace"');
    expect(html).toContain('attr-data-workspace-switch="team.id"');
    expect(html).toContain("{{ channel.name }}");
    expect(html).not.toContain("Messages are not yet modeled as Threads");
  });

  it("keeps the workflow link current on workspace workflow routes with trailing slashes", () => {
    expect(shellSetup).toContain('.replace(/^\\/ui/, "").replace(/\\/+$/, "") || "/"');
    expect(shellSetup).toContain(
      'activeSection.value = `workspace-${workspaceRoute[2] === "channels" ? "channels" : workspaceRoute[2] === "workflows" ? "workflows" : "runs"}`',
    );
    expect(html).toContain("attr-aria-current=\"activeSection === 'workspace-workflows' ? 'page' : null\"");
    expect(html).toContain("text-xs font-semibold text-app-secondary");
    expect(html).toContain(">Streams</span");
  });

  it("uses the completed URL route as the source of truth for workspace shell navigation", () => {
    expect(shellSetup).toContain("const syncWorkspace = () => syncSection()");
    expect(shellSetup).toContain('addEventListener("runner-route-changed", syncSection)');
    expect(shellSetup).toContain("setSelectedWorkspace(decodeURIComponent(workspaceRoute[1]))");
    expect(shellSetup).toContain('selectedChannelId.value = workspaceRoute[2] === "channels"');
    expect(html).toContain("attr-aria-pressed=\"team.isSelected ? 'true' : 'false'\"");
    expect(html).toContain('<template if="team.isSelected"');
    expect(shellSetup).toContain("isSelected: team.id === workspaceId");
  });

  it("keeps quick switch outside the inset panel and wraps navigation on mobile", () => {
    expect(html.indexOf("data-quick-switch-open")).toBeLessThan(
      html.indexOf("max-h-full min-h-0 min-w-0 overflow-y-auto"),
    );
    expect(html).toContain("max-h-[40dvh] min-w-0 flex-col items-stretch gap-2 overflow-y-auto");
    expect(html).toContain("flex min-w-0 flex-wrap items-center gap-1");
    expect(html).toContain("basis-full truncate px-3 py-1 text-sm font-semibold");
    expect(html).toContain("text-app-foreground md:basis-auto md:py-2");
    expect(html).toContain("basis-full px-3 pb-1 text-xs font-semibold text-app-secondary");
    expect(html).toContain('class="min-w-0 truncate"');
    expect(html).toContain(
      "shrink-0 items-center whitespace-nowrap rounded-full px-3 py-2 text-sm font-medium text-app-primary",
    );
    expect(html).toContain('class="mx-auto flex min-h-10 w-full min-w-0 items-center gap-2');
    expect(html).toContain("md:w-1/2");
    expect(html).toContain("p-2 pt-0 sm:p-3 sm:pt-0 md:col-start-3 md:row-start-1 md:p-4 md:pt-0");
    expect(html.match(/rounded-full px-2 py-2 text-sm text-app-secondary/g)).toHaveLength(5);
    expect(html).toContain("rounded-full border border-app-border bg-app-card font-semibold text-app-primary");
    expect(html).toContain("rounded-full px-3 py-2 text-sm font-medium text-app-primary");
    expect(html).not.toContain("sm:max-w-4xl");
    expect(html).toContain('class="min-w-0 flex-1 truncate">Search workspaces, streams, routes');
    expect(html).toContain('class="ml-auto shrink-0 rounded border border-app-border px-1.5 text-xs">⌘K');
  });

  it("frames main content in an inset rounded panel on every viewport edge", () => {
    expect(html).toContain("bg-app-background p-2 pt-0 sm:p-3 sm:pt-0 md:col-start-3 md:row-start-1 md:p-4 md:pt-0");
    expect(html).toContain("max-h-full min-h-0 min-w-0 overflow-y-auto overscroll-y-auto rounded-2xl bg-app-card");
    expect(html).toContain("grid-cols-[minmax(0,1fr)] grid-rows-[auto_minmax(0,1fr)]");
    expect(html).toContain("h-dvh grid grid-rows-[auto_minmax(0,1fr)]");
    expect(html).toContain("max-h-[40dvh] min-w-0 flex-col items-stretch gap-2 overflow-y-auto");
    expect(html).not.toMatch(/<body[^>]*overflow-hidden/);
    expect(html).not.toMatch(/data-app-layout[^>]*overflow-hidden/);
    expect(html).toContain("overscroll-y-auto");
    expect(html).not.toContain("md:rounded-tl-xl");
    expect(html).not.toContain("md:border-r");
  });

  it("keeps the sidebar unfilled and reserves the former shade for hover states", () => {
    expect(html).not.toContain("bg-app-sidebar");
    expect(html).not.toContain("bg-app-hover");
    expect(styles).toContain("--color-app-hover: #e9eee6");
    expect(styles).toContain("--color-app-hover: #111a14");
    expect(styles).not.toContain("--color-app-sidebar");
    expect(readFileSync(new URL("../ui/workflows-ui.html", import.meta.url), "utf8")).toContain("hover:bg-app-hover");
  });

  it("supports accessible keyboard quick navigation across known workspaces and routes", () => {
    expect(html).toContain("data-quick-switch-open");
    expect(html).toContain('role="dialog"');
    expect(html).toContain('aria-modal="true"');
    expect(html).toContain("data-quick-switch-search");
    expect(shellSetup).toContain("(event.metaKey || event.ctrlKey)");
    expect(shellSetup).toContain('event.key.toLowerCase() === "k"');
    expect(shellSetup).toContain('type: label === "channels" ? "Stream" : label');
    expect(shellSetup).toContain('label: "Settings", type: "Route"');
    expect(shellSetup).toContain("const quickSwitchItems = ref([])");
    expect(html).toContain('<template for="item of quickSwitchItems"');
    expect(html).toContain("{{ item.label }}");
    expect(html).toContain("{{ item.type }}");
    expect(html).toContain('attr-data-quick-switch-index="item.index"');
    expect(html).toContain('on-click="selectQuickSwitchItem(item)"');
    expect(html).toContain('if="quickSwitchItems.length === 0"');
    expect(shellSetup).not.toContain("renderQuickSwitch");
    expect(shellSetup).not.toContain("replaceChildren");
    expect(shellSetup).not.toContain("createElement");
    expect(shellSetup).not.toContain("textContent");
    expect(shellSetup).toContain('event.key === "ArrowDown" || event.key === "ArrowUp"');
    expect(shellSetup).toContain('event.key === "Enter"');
    expect(shellSetup).toContain('event.key === "Escape"');
    expect(shellSetup).toContain('removeEventListener("keydown", handleGlobalQuickSwitch)');
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
      {
        method: "GET",
        url: "/assets/app-shell.mjs",
        headers: { host: "app.test" },
      },
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
      {
        method: "GET",
        url: "/assets/preferences.mjs",
        headers: { host: "app.test" },
      },
      response,
    );

    expect(response.writeHead).toHaveBeenCalledWith(200, {
      "Cache-Control": "no-cache",
      "Content-Type": "text/javascript; charset=utf-8",
    });
    expect(response.end).toHaveBeenCalledWith(preferencesSetup);
  });
});
