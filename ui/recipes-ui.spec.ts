import { describe, expect, it } from "vitest";
import template from "./recipes.html?raw";
import setup from "./recipes-ui.mjs?raw";
import shell from "./app-shell.html?raw";

describe("recipe marketplace UI", () => {
  it("keeps the editor focused on YAML, validates its schema, and offers no deletion action", () => {
    expect(template).toContain("data-slug");
    expect(template).toContain("data-source");
    expect(template).toContain("data-validation");
    expect(template).toContain("data-editor-page");
    const editor = template.split("data-editor-page")[1].split("data-create-dialog")[0];
    expect(editor).not.toContain("data-slug");
    expect(editor).not.toContain("data-name");
    expect(template).not.toContain('name="id"');
    expect(setup).toContain('method: "POST"');
    expect(setup).toContain("/api/v1/recipes/validate");
    expect(setup).toContain("Create a new version or fork");
    expect(setup).toContain("/ui/recipes/new");
    expect(setup).toContain('searchParams.get("editor")');
    expect(setup).not.toMatch(/method:\s*["']DELETE/);
    expect(setup).not.toMatch(/delete.*recipe/i);
  });

  it("adds recipes to desktop and mobile navigation", () => {
    expect(shell.match(/href="\/ui\/recipes"/g)).toHaveLength(2);
  });
});
