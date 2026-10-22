import { describe, expect, it } from "vitest";
import template from "./recipes.html?raw";
import setup from "./recipes-ui.mjs?raw";
import shell from "./app-shell.html?raw";
import workflowTemplate from "./workflows-ui.html?raw";
import workflowSetup from "./workflows-ui.mjs?raw";

describe("recipe marketplace UI", () => {
  it("initializes page controls after the recipe component mounts", () => {
    expect(setup).toContain("onInit(() => {");
    expect(setup).toContain("cleanup = initializeRecipesPage()");
    expect(setup).toContain("onDestroy(() => cleanup?.())");
    expect(setup).toContain('root.querySelector("[data-create]").addEventListener("click"');
  });

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

  it("exposes the recipe library in global navigation and from workflows", () => {
    expect(shell).toContain('href="/ui/recipes"');
    expect(workflowTemplate).toContain("Browse recipe library");
    expect(workflowTemplate).toContain("Insert recipe");
    expect(workflowSetup).toContain("insertSelectedRecipe");
    expect(workflowSetup).toContain("commitRecipeInsertion");
    expect(workflowSetup).toContain("recipeSnapshot.value");
    expect(workflowTemplate).toContain("No recipes match that search.");
    expect(workflowTemplate).toContain("Loading recipes…");
    expect(workflowTemplate).toContain('bind-disabled="recipe.revoked"');
  });
});
