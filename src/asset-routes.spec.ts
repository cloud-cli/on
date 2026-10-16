import { readdirSync, readFileSync } from "node:fs";
import { describe, expect, it, vi } from "vitest";
import { WebhookServer } from "./server.js";

const htmlFiles = [
  ...readdirSync(new URL("../ui/", import.meta.url))
    .filter((file) => file.endsWith(".html"))
    .map((file) => new URL(`../ui/${file}`, import.meta.url)),
  ...readdirSync(new URL("./", import.meta.url))
    .filter((file) => file.endsWith(".html"))
    .map((file) => new URL(`./${file}`, import.meta.url)),
];
const setupUrls = [
  ...new Set(
    htmlFiles.flatMap((file) =>
      Array.from(readFileSync(file, "utf8").matchAll(/<script\s+setup\s+src="([^"]+)"/g), (match) => match[1]),
    ),
  ),
];
const workspaceTemplate = readFileSync(new URL("./teams-landing.html", import.meta.url), "utf8");

async function request(path: string) {
  const response = { writeHead: vi.fn().mockReturnThis(), end: vi.fn() };
  await (WebhookServer.prototype as any).handleRequest.call(
    {},
    { method: "GET", url: path, headers: { host: "flow.test" } },
    response,
  );
  return response;
}

describe("canonical setup-script asset routes", () => {
  it("keeps workspace template assets and navigation in canonical namespaces", () => {
    expect(workspaceTemplate).toContain('"@app/": "/assets/"');
    expect(workspaceTemplate).toContain('href="/assets/on.css"');
    expect(workspaceTemplate).toContain('src="/assets/teams-landing.mjs"');
    expect(workspaceTemplate).toContain("'/ui/workspaces/' + encodeURIComponent(team.id) + '/runs'");
    expect(workspaceTemplate).toContain("'/ui/workspaces/' + encodeURIComponent(team.id) + '/settings'");
  });

  it.each(setupUrls)("serves the setup module referenced at %s", async (url) => {
    expect(url).toMatch(/^\/assets\/.+\.mjs$/);

    const response = await request(url);

    expect(response.writeHead).toHaveBeenCalledWith(200, {
      "Cache-Control": "no-cache",
      "Content-Type": "text/javascript; charset=utf-8",
    });
    expect(response.end).toHaveBeenCalledOnce();
  });

  it("keeps the obsolete unnamespaced workspace setup URL unavailable", async () => {
    const response = await request("/teams-landing.mjs");

    expect(response.writeHead).toHaveBeenCalledWith(404, expect.any(Object));
    expect(response.end).toHaveBeenCalledOnce();
  });

  it("serves the workspace route helper from the canonical asset namespace", async () => {
    const response = await request("/assets/workspace-path.mjs");

    expect(response.writeHead).toHaveBeenCalledWith(200, {
      "Cache-Control": "no-cache",
      "Content-Type": "text/javascript; charset=utf-8",
    });
    expect(response.end).toHaveBeenCalledOnce();
  });
});
