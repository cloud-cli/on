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

  it("centers the create-recipe dialog in the viewport", () => {
    expect(template).toContain("fixed left-1/2 top-1/2 m-0");
    expect(template).toContain("-translate-x-1/2 -translate-y-1/2");
    expect(template).toContain("max-h-[calc(100dvh-2rem)]");
  });

  it("keeps the editor focused on YAML, validates its schema, and offers no deletion action", () => {
    expect(template).toContain("data-slug");
    expect(template).toContain("data-source");
    expect(template).toContain("<code-editor");
    expect(template).toContain('language="yaml"');
    expect(template).toContain('theme="googlecode"');
    expect(template).toContain('aria-label="Recipe YAML source"');
    expect(template).toContain("bg-app-card");
    expect(template).toContain("data-template-description");
    expect(template).toContain("data-validation");
    expect(template).toContain("data-editor-page");
    const editor = template.split("data-editor-page")[1].split("data-create-dialog")[0];
    expect(editor).not.toContain("data-slug");
    expect(editor).not.toContain("data-name");
    expect(template).not.toContain('name="id"');
    expect(setup).toContain('method: "POST"');
    expect(setup).toContain("/api/v1/recipes/validate");
    expect(setup).toContain('source.addEventListener("change"');
    expect(setup).toContain("event.detail");
    expect(setup).toContain("getSource()");
    expect(setup).toContain("Create a new version or fork");
    expect(template).toContain('data-kind="connectors"');
    expect(setup).toContain("Fork as new template version");
    expect(setup).toContain("/api/v1/connector-templates/validate");
    expect(setup).toContain("/api/v1/connector-templates");
    expect(setup).toContain("/ui/recipes/new");
    expect(setup).toContain('searchParams.get("editor")');
    expect(setup).not.toMatch(/method:\s*["']DELETE/);
    expect(setup).not.toMatch(/delete.*recipe/i);
  });

  it("exposes the recipe library in global navigation and workflow editor", () => {
    expect(shell).toContain('href="/ui/recipes"');
    expect(workflowTemplate).not.toContain("Browse recipe library");
    expect(workflowTemplate).toContain("Insert recipe");
    expect(workflowSetup).toContain("insertSelectedRecipe");
    expect(workflowSetup).toContain("commitRecipeInsertion");
    expect(workflowSetup).toContain("recipeSnapshot.value");
    expect(workflowTemplate).toContain("No recipes match that search.");
    expect(workflowTemplate).toContain("Loading recipes…");
    expect(workflowTemplate).toContain('bind-disabled="recipe.revoked"');
  });

  it("provides safe accessible connector installation and one-time secret handling", () => {
    expect(setup).not.toMatch(/\b(prompt|alert)\s*\(/);
    expect(setup).toContain("Array.isArray(workspaceResult.workspaces)");
    expect(setup).toContain("option.value = w.id");
    expect(setup).toContain("catalogGeneration");
    expect(setup).toContain("install.disabled = true");
    expect(setup).toContain("activeSecret = null");
    expect(setup).toContain("navigator.clipboard.writeText");
    expect(setup).toContain('searchParams.set("catalog", tab.dataset.kind)');
    expect(setup).toContain("listStatus.textContent");
    expect(template).toContain('role="status" aria-live="polite"');
    expect(template).toContain("data-secret-dismiss");
    expect(template).toContain("does not expire, but it is shown only once");
    expect(template).toContain("[overflow-wrap:anywhere]");
  });
});
