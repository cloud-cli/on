import { readdirSync, readFileSync } from "node:fs";
import { describe, expect, it, vi } from "vitest";
import { WebhookServer } from "./server.js";
import recipeTemplate from "../ui/recipes.html?raw";
import recipeSetup from "../ui/recipes-ui.mjs?raw";

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
    { method: "GET", url: path, headers: { host: "app.test" } },
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

  it("uses full-width workspace cards that open recent runs with a separate edit action", () => {
    expect(workspaceTemplate).toContain('class="grid grid-cols-1 gap-3"');
    expect(workspaceTemplate).toContain("'Open ' + team.name + ' recent runs'");
    expect(workspaceTemplate).toContain("'Edit ' + team.name + ' settings'");
    expect(workspaceTemplate).toContain(">\n                    Edit\n                  </a>");
    expect(workspaceTemplate).not.toContain("sm:grid-cols-2");
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

  it("serves the safe recipe insertion helper through the assets namespace", async () => {
    const response = await request("/assets/recipe-insertion.mjs");

    expect(response.writeHead).toHaveBeenCalledWith(200, {
      "Cache-Control": "no-cache",
      "Content-Type": "text/javascript; charset=utf-8",
    });
    expect(response.end).toHaveBeenCalledWith(expect.stringContaining("prepareRecipeInsertion"));
  });

  it("serves and wires the recipe publish page and setup module", async () => {
    const setup = await request("/assets/pages/recipes-ui.mjs");

    expect(recipeTemplate).toContain('<script setup src="/assets/pages/recipes-ui.mjs"></script>');
    expect(setup.writeHead).toHaveBeenCalledWith(200, {
      "Cache-Control": "no-cache",
      "Content-Type": "text/javascript; charset=utf-8",
    });
    expect(setup.end).toHaveBeenCalledWith(recipeSetup);
    expect(recipeSetup).toContain('root.querySelector("[data-create]").addEventListener("click"');
    expect(recipeSetup).toContain('form.addEventListener("submit"');
    expect(recipeSetup).toContain('method: "POST"');
  });
});
