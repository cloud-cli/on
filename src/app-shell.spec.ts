import { readdirSync, readFileSync } from "node:fs";
import { describe, expect, it, vi } from "vitest";
import { WebhookServer } from "./server.js";
import shellSetup from "../ui/app-shell.mjs?raw";
import preferencesSetup from "../ui/preferences.mjs?raw";

const html = readFileSync(new URL("../ui/app-shell.html", import.meta.url), "utf8");

describe("Flow application shell", () => {
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
    expect(html).toContain('aria-label="Primary navigation"');
    expect(html).toContain('aria-label="Mobile navigation"');
    expect(html).toContain("bottom-0 z-50");
    expect(html).toContain("pb-[calc(env(safe-area-inset-bottom)_+_0.5rem)] pt-2");
    expect(html).not.toContain('href="/runs"');
    expect(html.match(/href="\/workflows"/g)).toHaveLength(2);
    expect(html.match(/href="\/settings"/g)).toHaveLength(2);
    expect(html.match(/href="\/workspaces"/g)).toHaveLength(3);
    expect(html).toContain("activeSection === 'settings' ? 'page' : null");
    expect(html).toContain("focus-visible:ring-2");
    expect(html).toContain('>flow<span class="text-[#729b5b]">.</span>');
    expect(html).toContain("w-[27px] rounded-[2px] bg-[#547d42]");
    expect(html).toContain('href="#main-content"');
    expect(html).toContain("data-skip-to-content");
    expect(html).toContain('id="main-content"');
    expect(html).toContain('tabindex="-1"');
    expect(html).toContain('class="min-h-dvh bg-flow-background');
    expect(html).toContain("min-h-dvh md:grid md:grid-cols-[16rem_minmax(0,1fr)]");
    expect(html).toContain("sticky top-0 hidden h-dvh self-start overflow-y-auto");
    expect(html).toContain("min-h-dvh min-w-0 pb-20 md:pb-0");
    expect(html).not.toContain("overscroll-y-contain");
    expect(html).not.toContain("overflow-hidden bg-flow-background");
    expect(html).toContain('role="group"');
    expect(html).toContain('aria-label="Signed-in user"');
    expect(html).toContain('on-click="toggleTheme()"');
    expect(html).toContain('class="flex items-center justify-end gap-4');
    expect(html).toContain('md:flex"');
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
    expect(html).not.toContain("min-h-screen border-r border-flow-border");
    expect(html.indexOf("My workspaces")).toBeLessThan(html.indexOf("Workflows"));
    expect(html.indexOf("Preferences")).toBeLessThan(html.indexOf("Your workspaces"));
    expect(html).not.toContain("mt-auto");
  });

  it("loads the signed-in profile from the session endpoint without inventing a user", () => {
    expect(shellSetup).toContain('fetch("/api/v1/auth/session"');
    expect(shellSetup).toContain("session?.authenticated || !session.user");
    expect(html).toContain("user.name || user.email");
    expect(html).toContain("{{ user.email }}");
    expect(html).toContain('target="_blank"');
    expect(html).toContain('rel="noopener"');
    expect(html).toContain("oidcProviderUrl");
    expect(html).toContain('if="userAuthenticated"');
  });

  it("lists workspaces in the sidebar and links each workspace to its settings page", () => {
    const teamsList = html.indexOf('aria-label="Your workspaces"');

    expect(teamsList).toBeGreaterThan(html.indexOf('aria-label="Primary navigation"'));
    expect(teamsList).toBeLessThan(html.indexOf('id="main-content"'));
    expect(html).toContain("# {{ team.name }}");
    expect(html).toContain("'/workspaces/' + encodeURIComponent(team.id) + '/runs'");
    expect(html).toContain('on-click="selectWorkspace(team.id)"');
    expect(html).toContain("selectedWorkspaceId === team.id");
    expect(shellSetup).toContain('fetch("/api/v1/workspaces"');
    expect(shellSetup).toContain('addEventListener("runner-teams-updated", loadTeams)');
    expect(shellSetup).toContain('path.startsWith("/workspaces/")');
    expect(html).toContain(">Your workspaces</p>");
    expect(html).toContain("px-3 py-2.5 text-sm text-flow-secondary");
    expect(html).toContain("grid-cols-3");
  });

  it("handles Enter and Space on the skip link without triggering browser navigation", () => {
    expect(shellSetup).toContain('["Enter", " "].includes(event.key)');
    expect(shellSetup).toContain("event.preventDefault()");
    expect(shellSetup).toContain('getElementById("main-content")');
    expect(shellSetup).toContain('addEventListener("keydown", handleSkipKeydown)');
    expect(shellSetup).toContain('removeEventListener("keydown", handleSkipKeydown)');
  });

  it("serves the shell setup module referenced by the app shell", async () => {
    expect(html).toContain('<script setup src="/app-shell.mjs"></script>');
    expect(shellSetup).toContain('from "@app/preferences.mjs"');
    const response = { writeHead: vi.fn().mockReturnThis(), end: vi.fn() };

    await (WebhookServer.prototype as any).handleRequest.call(
      {},
      { method: "GET", url: "/app-shell.mjs", headers: { host: "flow.test" } },
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
      { method: "GET", url: "/preferences.mjs", headers: { host: "flow.test" } },
      response,
    );

    expect(response.writeHead).toHaveBeenCalledWith(200, {
      "Cache-Control": "no-cache",
      "Content-Type": "text/javascript; charset=utf-8",
    });
    expect(response.end).toHaveBeenCalledWith(preferencesSetup);
  });
});
