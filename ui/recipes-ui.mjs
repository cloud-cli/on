import { apiFetch } from "@app/api-client.mjs";
import { onDestroy, onInit } from "@li3/web";

const DRAFT_KEY = "on-recipe-draft";

export default function () {
  let cleanup;
  onInit(() => {
    cleanup = initializeRecipesPage();
  });
  onDestroy(() => cleanup?.());
}

function initializeRecipesPage() {
  const editorRoute =
    new URL(window.location.href).pathname.endsWith("/recipes/new") ||
    new URL(window.location.href).searchParams.get("editor") === "1";
  const component = editorRoute ? "page-recipe-editor" : "page-recipes";
  const root = document.querySelector(`${component} [data-recipes-root]`);
  if (!root) {
    console.error(`Recipes UI root not found for ${component}`);
    return;
  }

  const marketplace = root.querySelector("[data-marketplace]");
  const editorPage = root.querySelector("[data-editor-page]");
  const list = root.querySelector("[data-list]");
  const form = root.querySelector("[data-form]");
  const source = root.querySelector("[data-source]");
  const validation = root.querySelector("[data-validation]");
  const saveButton = root.querySelector("[data-save]");
  const error = root.querySelector("[data-error]");
  const listError = root.querySelector("[data-list-error]");
  const dialog = root.querySelector("[data-create-dialog]");
  const createForm = root.querySelector("[data-create-form]");

  const goTo = (path) => {
    history.pushState(null, "", path);
    window.dispatchEvent(new PopStateEvent("popstate"));
  };
  const loadRecipes = async () => {
    list.replaceChildren();
    listError.classList.add("hidden");
    const response = await apiFetch("/api/v1/recipes", { headers: { accept: "application/json" } });
    const result = await response.json();
    if (!response.ok) {
      throw new Error(result.error || "Unable to load recipes");
    }
    for (const recipe of result.recipes || []) {
      const card = document.createElement("article");
      card.className = "rounded-2xl border border-app-border bg-white p-5 shadow-sm";
      const title = document.createElement("h2");
      title.className = "text-lg font-semibold";
      title.textContent = recipe.name;
      const ref = document.createElement("p");
      ref.className = "mt-1 font-mono text-sm text-app-secondary";
      ref.textContent = `${recipe.namespace}/${recipe.slug}@v${recipe.version}${recipe.revoked ? " · revoked" : ""}`;
      const details = document.createElement("details");
      details.className = "mt-3";
      const summary = document.createElement("summary");
      summary.className = "cursor-pointer text-sm text-app-primary";
      summary.textContent = "View source";
      const code = document.createElement("pre");
      code.className = "mt-2 max-h-80 overflow-auto rounded-lg bg-slate-950 p-3 text-xs text-white";
      code.textContent = recipe.sourceYaml;
      details.append(summary, code);
      const newVersion = document.createElement("button");
      newVersion.type = "button";
      newVersion.className = "mt-4 text-sm font-semibold text-app-primary";
      newVersion.textContent = "Create a new version or fork";
      newVersion.addEventListener("click", () => {
        sessionStorage.setItem(
          DRAFT_KEY,
          JSON.stringify({ slug: recipe.slug, name: recipe.name, sourceYaml: recipe.sourceYaml }),
        );
        goTo("/ui/recipes/new");
      });
      card.append(title, ref, details, newVersion);
      list.append(card);
    }
  };

  const isEditor = () =>
    new URL(window.location.href).pathname.endsWith("/recipes/new") ||
    new URL(window.location.href).searchParams.get("editor") === "1";
  const showCurrentPage = () => {
    const editor = isEditor();
    marketplace.classList.toggle("hidden", editor);
    editorPage.classList.toggle("hidden", !editor);
    if (editor) {
      const draft = JSON.parse(sessionStorage.getItem(DRAFT_KEY) || "{}");
      root.querySelector("[data-editor-title]").textContent = draft.slug ? "Publish recipe version" : "New recipe";
      root.querySelector("[data-editor-reference]").textContent = draft.slug ? `${draft.slug} · ${draft.name}` : "";
      source.value = draft.sourceYaml || "";
      void validateSource();
      source.focus();
    }
  };

  root.querySelector("[data-create]").addEventListener("click", () => {
    createForm.reset();
    root.querySelector("[data-create-error]").classList.add("hidden");
    dialog.showModal();
  });
  createForm.addEventListener("submit", (event) => {
    if (event.submitter?.value !== "create") {
      return;
    }
    event.preventDefault();
    if (!createForm.reportValidity()) {
      return;
    }
    sessionStorage.setItem(
      DRAFT_KEY,
      JSON.stringify({ slug: root.querySelector("[data-slug]").value, name: root.querySelector("[data-name]").value }),
    );
    dialog.close();
    goTo("/ui/recipes/new");
  });
  root.querySelector("[data-cancel]").addEventListener("click", () => {
    sessionStorage.removeItem(DRAFT_KEY);
    goTo("/ui/recipes");
  });

  let validationTimer;
  let validationGeneration = 0;
  const validateSource = async () => {
    const generation = ++validationGeneration;
    saveButton.disabled = true;
    validation.textContent = "Validating recipe and input JSON Schema…";
    validation.className = "text-sm text-app-secondary";
    try {
      const response = await apiFetch("/api/v1/recipes/validate", {
        method: "POST",
        headers: { accept: "application/json", "content-type": "application/json" },
        body: JSON.stringify({ sourceYaml: source.value }),
      });
      const result = await response.json();
      if (generation !== validationGeneration) {
        return;
      }
      if (!response.ok || !result.valid) {
        throw new Error(result.error || "Recipe validation failed");
      }
      validation.textContent = "Recipe and JSON Schema are valid.";
      validation.className = "text-sm text-emerald-700";
      saveButton.disabled = false;
    } catch (cause) {
      if (generation !== validationGeneration) {
        return;
      }
      validation.textContent = cause.message || "Recipe validation failed";
      validation.className = "text-sm text-rose-700";
    }
  };
  source.addEventListener("input", () => {
    clearTimeout(validationTimer);
    saveButton.disabled = true;
    validationTimer = setTimeout(() => void validateSource(), 350);
  });

  form.addEventListener("submit", async (event) => {
    event.preventDefault();
    saveButton.disabled = true;
    error.classList.add("hidden");
    try {
      const metadata = JSON.parse(sessionStorage.getItem(DRAFT_KEY) || "{}");
      const response = await apiFetch("/api/v1/recipes", {
        method: "POST",
        headers: { accept: "application/json", "content-type": "application/json" },
        body: JSON.stringify({ slug: metadata.slug, name: metadata.name, sourceYaml: source.value }),
      });
      const result = await response.json();
      if (!response.ok) {
        throw new Error(result.error || "Recipe could not be published");
      }
      sessionStorage.removeItem(DRAFT_KEY);
      history.replaceState(null, "", "/ui/recipes");
      window.dispatchEvent(new PopStateEvent("popstate"));
      window.dispatchEvent(new Event("runner-recipes-updated"));
    } catch (cause) {
      error.textContent = cause.message || "Recipe could not be published";
      error.classList.remove("hidden");
      saveButton.disabled = false;
    }
  });

  const refresh = () => {
    if (!isEditor()) {
      void loadRecipes().catch((cause) => {
        listError.textContent = cause.message || "Unable to load recipes";
        listError.classList.remove("hidden");
      });
    }
  };
  const popstate = () => {
    showCurrentPage();
    refresh();
  };
  window.addEventListener("runner-recipes-updated", refresh);
  window.addEventListener("popstate", popstate);
  showCurrentPage();
  refresh();
  return () => {
    clearTimeout(validationTimer);
    window.removeEventListener("runner-recipes-updated", refresh);
    window.removeEventListener("popstate", popstate);
  };
}
