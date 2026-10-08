import { readFileSync } from "node:fs";
import { describe, expect, it, vi } from "vitest";
import { WebhookServer } from "./server.js";
import shellSetup from "./app-shell.mjs?raw";

const html = readFileSync(new URL("./app-shell.html", import.meta.url), "utf8");

describe("Flow application shell", () => {
  it("provides responsive, accessible navigation around the mounted router", () => {
    expect(html).toContain('aria-label="Primary navigation"');
    expect(html).toContain('aria-label="Mobile navigation"');
    expect(html).toContain("bottom-0 z-50");
    expect(html).toContain("pb-[calc(env(safe-area-inset-bottom)_+_0.5rem)] pt-2");
    expect(html.match(/href="\/runs"/g)).toHaveLength(3);
    expect(html.match(/href="\/workflows"/g)).toHaveLength(2);
    expect(html.match(/href="\/settings"/g)).toHaveLength(2);
    expect(html).toContain("activeSection === 'settings' ? 'page' : null");
    expect(html).toContain("focus-visible:ring-2");
    expect(html).toContain('>flow<span class="text-[#729b5b]">.</span>');
    expect(html).toContain("w-[27px] rounded-[2px] bg-[#547d42]");
    expect(html).toContain('href="#main-content"');
    expect(html).toContain('id="main-content"');
    expect(html).not.toContain('<main class="min-h-screen min-w-0');
    expect(html).toContain("<app-router></app-router>");
    expect(html).not.toContain("Workers</a>");
    expect(html).not.toContain("Engineering");
    expect(html).not.toContain("JD");
    expect(html).not.toContain("min-h-screen border-r border-flow-border");
    expect(html.indexOf("Settings</a")).toBeLessThan(html.indexOf('if="userAuthenticated"'));
    expect(html).not.toContain("mt-auto");
  });

  it("loads the signed-in profile from the session endpoint without inventing a user", () => {
    expect(shellSetup).toContain('fetch("/api/auth/session"');
    expect(shellSetup).toContain("session?.authenticated || !session.user");
    expect(html).toContain("user.name || user.email");
    expect(html).toContain("{{ user.email }}");
    expect(html).toContain("{{ user.role }}");
    expect(html).toContain('target="_blank"');
    expect(html).toContain('rel="noopener"');
    expect(html).toContain("oidcProviderUrl");
    expect(html).toContain('icon="external-link"');
    expect(html).toContain('if="userAuthenticated"');
  });

  it("serves the shell setup module referenced by the app shell", async () => {
    expect(html).toContain('<script setup src="/app-shell.mjs"></script>');
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
});
