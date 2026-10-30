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
  const initialUrl = new URL(window.location.href);
  root.dataset.catalogKind = initialUrl.searchParams.get("catalog") === "connectors" ? "connectors" : "recipes";
  const syncKindControls = () =>
    root.querySelectorAll("[data-kind]").forEach((item) => {
      const active = item.dataset.kind === root.dataset.catalogKind;
      item.setAttribute("aria-pressed", String(active));
      item.classList.toggle("bg-app-primary", active);
      item.classList.toggle("text-white", active);
    });
  syncKindControls();

  const marketplace = root.querySelector("[data-marketplace]");
  const editorPage = root.querySelector("[data-editor-page]");
  const list = root.querySelector("[data-list]");
  const form = root.querySelector("[data-form]");
  const source = root.querySelector("[data-source]");
  const descriptionInput = root.querySelector("[data-template-description]");
  const getSource = () => source.value ?? "";
  const setSource = (value) => {
    source.value = value;
  };
  const validation = root.querySelector("[data-validation]");
  const saveButton = root.querySelector("[data-save]");
  const error = root.querySelector("[data-error]");
  const listError = root.querySelector("[data-list-error]");
  const listStatus = root.querySelector("[data-list-status]");
  const dialog = root.querySelector("[data-create-dialog]");
  const createForm = root.querySelector("[data-create-form]");
  const installDialog = root.querySelector("[data-install-dialog]");
  const workspaceSelect = root.querySelector("[data-workspace]");
  const installError = root.querySelector("[data-install-error]");
  const secretDialog = root.querySelector("[data-secret-dialog]");
  let activeSecret = null;
  let catalogGeneration = 0;

  const goTo = (path) => {
    history.pushState(null, "", path);
    window.dispatchEvent(new PopStateEvent("popstate"));
  };
  const isConnectorEditor = () => new URL(window.location.href).searchParams.get("type") === "connector";
  const loadRecipes = async () => {
    const generation = ++catalogGeneration;
    const kind = root.dataset.catalogKind;
    list.replaceChildren();
    listError.classList.add("hidden");
    listStatus.textContent = "Loading catalog…";
    if (kind === "connectors") {
      const response = await apiFetch("/api/v1/connector-templates", { headers: { accept: "application/json" } });
      const result = await response.json();
      if (generation !== catalogGeneration || kind !== root.dataset.catalogKind) {
        return;
      }
      if (!response.ok) {
        throw new Error(result.error || "Unable to load connector templates");
      }
      for (const template of result.connectorTemplates || []) {
        const card = document.createElement("article");
        card.className = "rounded-2xl border border-app-border bg-white p-5 shadow-sm";
        const title = document.createElement("h2");
        title.className = "text-lg font-semibold";
        title.textContent = template.name;
        const type = document.createElement("p");
        type.className = "mt-1 text-xs font-semibold uppercase tracking-wide text-app-primary";
        type.textContent = "Connector template · immutable";
        const description = document.createElement("p");
        description.className = "mt-2 text-sm text-app-secondary";
        description.textContent = template.description;
        const reference = document.createElement("p");
        reference.className = "mt-2 font-mono text-xs text-app-secondary";
        reference.textContent = `${template.namespace}/${template.slug}@v${template.version}`;
        const sourceDetails = document.createElement("details");
        sourceDetails.className = "mt-3";
        const sourceSummary = document.createElement("summary");
        sourceSummary.className = "cursor-pointer text-sm text-app-primary";
        sourceSummary.textContent = "View source";
        const sourceCode = document.createElement("pre");
        sourceCode.className = "mt-2 max-h-80 overflow-auto rounded-lg bg-slate-950 p-3 text-xs text-white";
        sourceCode.textContent = template.sourceYaml;
        sourceDetails.append(sourceSummary, sourceCode);
        const fork = document.createElement("button");
        fork.type = "button";
        fork.className = "mt-4 mr-3 text-sm font-semibold text-app-primary";
        fork.textContent = "Fork as new template version";
        fork.addEventListener("click", () => {
          sessionStorage.setItem(
            DRAFT_KEY,
            JSON.stringify({
              kind: "connector",
              slug: template.slug,
              name: template.name,
              description: template.description,
              sourceYaml: template.sourceYaml,
            }),
          );
          goTo("/ui/recipes/new?type=connector&catalog=connectors");
        });
        const install = document.createElement("button");
        install.type = "button";
        install.className = "mt-4 rounded-lg bg-app-primary px-3 py-2 text-sm font-semibold text-white";
        install.textContent = "Install in workspace";
        install.addEventListener("click", async () => {
          if (install.disabled) {
            return;
          }
          install.disabled = true;
          install.textContent = "Loading workspaces…";
          try {
            const workspacesResponse = await apiFetch("/api/v1/workspaces", {
              headers: { accept: "application/json" },
            });
            const workspaceResult = await workspacesResponse.json();
            if (
              !workspacesResponse.ok ||
              !Array.isArray(workspaceResult.workspaces) ||
              !workspaceResult.workspaces.every((w) => w && typeof w.id === "string" && typeof w.name === "string")
            ) {
              throw new Error(workspaceResult.error || "Unable to verify available workspaces.");
            }
            const workspaces = workspaceResult.workspaces;
            if (!workspaces.length) {
              throw new Error("Create or join a workspace before installing a connector.");
            }
            workspaceSelect.replaceChildren(
              ...workspaces.map((w) => {
                const option = document.createElement("option");
                option.value = w.id;
                option.textContent = `${w.name} (${w.id})`;
                return option;
              }),
            );
            installError.classList.add("hidden");
            installDialog.showModal();
            const installHandler = async (event) => {
              event.preventDefault();
              const workspace = workspaces.find((w) => w.id === workspaceSelect.value);
              if (!workspace) {
                return;
              }
              const submit = installDialog.querySelector('button[type="submit"]');
              if (submit.disabled) {
                return;
              }
              submit.disabled = true;
              submit.textContent = "Installing…";
              try {
                const installed = await apiFetch(
                  `/api/v1/workspaces/${encodeURIComponent(workspace.id)}/connector-templates/${encodeURIComponent(template.namespace)}/${encodeURIComponent(template.slug)}/versions/${template.version}/install`,
                  {
                    method: "POST",
                    headers: { accept: "application/json", "content-type": "application/json" },
                    body: JSON.stringify({}),
                  },
                );
                const data = await installed.json();
                if (!installed.ok) {
                  throw new Error(data.error || "Template installation failed");
                }
                const absoluteUrl = new URL(data.url, window.location.origin);
                if (!/^https?:$/.test(absoluteUrl.protocol) || absoluteUrl.origin !== window.location.origin) {
                  throw new Error("The server returned an invalid webhook URL.");
                }
                activeSecret = { url: absoluteUrl.href, signingSecret: data.signingSecret };
                root.querySelector("[data-secret-url]").value = activeSecret.url;
                root.querySelector("[data-secret-value]").value = activeSecret.signingSecret;
                installDialog.close();
                secretDialog.showModal();
                install.textContent = "Installed";
                install.setAttribute("aria-label", `Installed in ${workspace.name}`);
                listStatus.textContent = `Connector installed in ${workspace.name}.`;
              } catch (cause) {
                installError.textContent = cause.message || "Template installation failed";
                installError.classList.remove("hidden");
              } finally {
                submit.disabled = false;
                submit.textContent = "Install";
              }
            };
            installDialog.querySelector("[data-install-form]").onsubmit = installHandler;
            return;
          } catch (cause) {
            listError.textContent = cause.message || "Template installation failed";
            listError.classList.remove("hidden");
          } finally {
            if (install.isConnected && install.textContent !== "Installed") {
              install.disabled = false;
              install.textContent = "Install in workspace";
            }
          }
        });
        card.append(type, title, description, reference, sourceDetails, fork, install);
        list.append(card);
      }
      listStatus.textContent = list.children.length
        ? `${list.children.length} connector templates.`
        : "No connector templates available yet.";
      return;
    }
    const response = await apiFetch("/api/v1/recipes", { headers: { accept: "application/json" } });
    const result = await response.json();
    if (generation !== catalogGeneration || kind !== root.dataset.catalogKind) {
      return;
    }
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
    listStatus.textContent = list.children.length ? `${list.children.length} recipes.` : "No recipes available yet.";
  };

  const isEditor = () =>
    new URL(window.location.href).pathname.endsWith("/recipes/new") ||
    new URL(window.location.href).searchParams.get("editor") === "1";
  const showCurrentPage = () => {
    const editor = isEditor();
    const connectorEditor = editor && isConnectorEditor();
    marketplace.classList.toggle("hidden", editor);
    editorPage.classList.toggle("hidden", !editor);
    if (editor) {
      const draft = JSON.parse(sessionStorage.getItem(DRAFT_KEY) || "{}");
      root.querySelector("[data-editor-title]").textContent = connectorEditor
        ? draft.slug
          ? "Publish connector template version"
          : "Publish connector template"
        : draft.slug
          ? "Publish recipe version"
          : "New recipe";
      root.querySelector("[data-editor-reference]").textContent = draft.slug ? `${draft.slug} · ${draft.name}` : "";
      root.querySelector("[data-source-label]").textContent = connectorEditor ? "Connector YAML" : "Recipe YAML";
      source.setAttribute("aria-label", connectorEditor ? "Connector YAML source" : "Recipe YAML source");
      root.querySelector("[data-description-wrap]").classList.toggle("hidden", !connectorEditor);
      descriptionInput.value = connectorEditor ? draft.description || "" : "";
      setSource(draft.sourceYaml || "");
      void validateSource();
      source.focus();
    }
  };

  root.querySelector("[data-create]").addEventListener("click", () => {
    createForm.reset();
    const connectors = root.dataset.catalogKind === "connectors";
    root.querySelector("[data-create-dialog-title]").textContent = connectors
      ? "Create connector template"
      : "Create recipe";
    root.querySelector("[data-create-description-wrap]").classList.toggle("hidden", !connectors);
    root.querySelector("[data-description]").required = connectors;
    root.querySelector("[data-create-error]").classList.add("hidden");
    dialog.showModal();
  });
  root.querySelectorAll("[data-kind]").forEach((tab) =>
    tab.addEventListener("click", () => {
      root.dataset.catalogKind = tab.dataset.kind;
      const currentUrl = new URL(window.location.href);
      currentUrl.searchParams.set("catalog", tab.dataset.kind);
      history.replaceState(null, "", currentUrl);
      root.querySelectorAll("[data-kind]").forEach((item) => {
        const active = item === tab;
        item.setAttribute("aria-pressed", String(active));
        item.classList.toggle("bg-app-primary", active);
        item.classList.toggle("text-white", active);
      });
      root.querySelector("[data-create]").textContent =
        tab.dataset.kind === "connectors" ? "Publish connector template" : "Publish recipe";
      void loadRecipes().catch((cause) => {
        listError.textContent = cause.message || "Unable to load catalog";
        listError.classList.remove("hidden");
      });
    }),
  );
  root.querySelector("[data-install-cancel]").addEventListener("click", () => installDialog.close());
  const clearSecrets = () => {
    root.querySelector("[data-secret-url]").value = "";
    root.querySelector("[data-secret-value]").value = "";
    activeSecret = null;
    secretDialog.close();
  };
  root.querySelector("[data-secret-dismiss]").addEventListener("click", clearSecrets);
  secretDialog.addEventListener("cancel", (event) => event.preventDefault());
  for (const [buttonSelector, inputSelector, statusSelector, name] of [
    ["[data-copy-url]", "[data-secret-url]", "[data-url-copy-status]", "Webhook URL"],
    ["[data-copy-secret]", "[data-secret-value]", "[data-secret-copy-status]", "Signing secret"],
  ]) {
    root.querySelector(buttonSelector).addEventListener("click", async () => {
      const input = root.querySelector(inputSelector);
      try {
        await navigator.clipboard.writeText(input.value);
        root.querySelector(statusSelector).textContent = `${name} copied.`;
      } catch {
        input.focus();
        input.select();
        root.querySelector(statusSelector).textContent = `Select and copy the ${name.toLowerCase()} manually.`;
      }
    });
  }
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
      JSON.stringify({
        kind: root.dataset.catalogKind === "connectors" ? "connector" : "recipe",
        slug: root.querySelector("[data-slug]").value,
        name: root.querySelector("[data-name]").value,
        ...(root.dataset.catalogKind === "connectors"
          ? { description: root.querySelector("[data-description]").value }
          : {}),
      }),
    );
    dialog.close();
    goTo(
      root.dataset.catalogKind === "connectors"
        ? "/ui/recipes/new?type=connector&catalog=connectors"
        : "/ui/recipes/new?catalog=recipes",
    );
  });
  root.querySelector("[data-cancel]").addEventListener("click", () => {
    sessionStorage.removeItem(DRAFT_KEY);
    goTo(root.dataset.catalogKind === "connectors" ? "/ui/recipes?catalog=connectors" : "/ui/recipes");
  });

  let validationTimer;
  let validationGeneration = 0;
  const validateSource = async () => {
    const generation = ++validationGeneration;
    saveButton.disabled = true;
    validation.textContent = isConnectorEditor()
      ? "Validating restricted connector YAML…"
      : "Validating recipe and input JSON Schema…";
    validation.className = "text-sm text-app-secondary";
    try {
      const response = await apiFetch(
        isConnectorEditor() ? "/api/v1/connector-templates/validate" : "/api/v1/recipes/validate",
        {
          method: "POST",
          headers: { accept: "application/json", "content-type": "application/json" },
          body: JSON.stringify({ sourceYaml: getSource() }),
        },
      );
      const result = await response.json();
      if (generation !== validationGeneration) {
        return;
      }
      if (!response.ok || !result.valid) {
        throw new Error(result.error || "Recipe validation failed");
      }
      validation.textContent = isConnectorEditor() ? "Connector YAML is valid." : "Recipe and JSON Schema are valid.";
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
  source.addEventListener("change", (event) => {
    if (typeof event.detail === "string") {
      setSource(event.detail);
    }
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
      const connectorEditor = isConnectorEditor();
      const response = await apiFetch(connectorEditor ? "/api/v1/connector-templates" : "/api/v1/recipes", {
        method: "POST",
        headers: { accept: "application/json", "content-type": "application/json" },
        body: JSON.stringify({
          slug: metadata.slug,
          name: metadata.name,
          ...(connectorEditor ? { description: descriptionInput.value } : {}),
          sourceYaml: getSource(),
        }),
      });
      const result = await response.json();
      if (!response.ok) {
        throw new Error(
          result.error ||
            (connectorEditor ? "Connector template could not be published" : "Recipe could not be published"),
        );
      }
      sessionStorage.removeItem(DRAFT_KEY);
      history.replaceState(null, "", connectorEditor ? "/ui/recipes?catalog=connectors" : "/ui/recipes");
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
      listStatus.textContent = "Loading catalog…";
      void loadRecipes().catch((cause) => {
        listError.textContent = cause.message || "Unable to load recipes";
        listError.classList.remove("hidden");
        listStatus.textContent = "Catalog could not be loaded.";
      });
    }
  };
  const popstate = () => {
    const url = new URL(window.location.href);
    root.dataset.catalogKind =
      url.searchParams.get("catalog") === "connectors" || url.searchParams.get("type") === "connector"
        ? "connectors"
        : "recipes";
    syncKindControls();
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
