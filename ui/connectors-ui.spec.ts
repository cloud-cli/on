import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { matchRoute } from "./route-table.mjs";

describe("workspace Connectors page", () => {
  it("routes list, creation, and editor under the selected workspace", () => {
    expect(matchRoute("/ui/workspaces/acme/connectors")).toMatchObject({ page: "connectors", teamId: "acme" });
    expect(matchRoute("/ui/workspaces/acme/connectors/new")).toMatchObject({
      page: "connector-editor",
      teamId: "acme",
    });
    expect(matchRoute("/ui/workspaces/acme/connectors/ingest")).toMatchObject({
      page: "connector-editor",
      teamId: "acme",
    });
  });

  it("provides accessible draft, publish, toggle, and confirmed-delete controls", () => {
    const html = readFileSync(new URL("./connectors-ui.html", import.meta.url), "utf8");
    const setup = readFileSync(new URL("./connectors-ui.mjs", import.meta.url), "utf8");
    expect(html).toContain('aria-label="Connector YAML"');
    expect(html).toContain('on-click="save()"');
    expect(html).toContain('on-click="publish()"');
    expect(html).toContain('on-click="remove()"');
    expect(setup).toContain("/draft");
    expect(setup).toContain("/publish");
    expect(setup).toContain("/enabled");
    expect(setup).toContain("Permanently delete connector");
  });

  it("removes recipe-library browsing from workflow list", () => {
    expect(readFileSync(new URL("./workflows-ui.html", import.meta.url), "utf8")).not.toContain(
      "Browse recipe library",
    );
  });
});
