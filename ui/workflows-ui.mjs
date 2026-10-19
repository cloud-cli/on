import { onDestroy, onInit, ref, templateRef } from "@li3/web";
import { diffLines } from "diff";
import { navigateTo } from "@app/app-router.mjs";
import { apiFetch } from "@app/api-client.mjs";

export default function () {
  const params = new URLSearchParams(window.location.search);
  const workflowPath = window.location.pathname
    .replace(/^\/ui/, "")
    .match(/^\/(?:settings\/)?workflows\/(new|[a-z0-9-]+)$/);
  const page = workflowPath ? "editor" : document.body.dataset.page || params.get("page") || "workflows";
  const pathWorkflowId = workflowPath && workflowPath[1] !== "new" ? workflowPath[1] : "";
  const initialId = params.get("id") || pathWorkflowId;
  const initialRevision = params.get("revision") ? Number(params.get("revision")) : null;
  const readOnly = Boolean(initialRevision);
  const workflows = ref([]);
  const availableWorkspaces = ref([]);
  const workspacesLoading = ref(page === "editor");
  const initialWorkspaceId = params.get("workspaceId") || localStorage.getItem("runner-team-id") || "";
  const selectedWorkspaceId = ref(initialWorkspaceId);
  const secrets = ref([]);
  const source = ref("");
  const validation = ref({ valid: true });
  const savedSource = ref("");
  const revision = ref(null);
  const revisionDialogOpen = ref(false);
  const revisionNumber = ref(0);
  const revisionDiffHtml = ref("");
  const revisionError = ref("");
  const revisionLoading = ref(false);
  const aiDialogOpen = ref(false);
  const aiRequest = ref("");
  const aiLoading = ref(false);
  const aiError = ref("");
  const aiSuggestion = ref("");
  const aiDiffHtml = ref("");
  const workflowId = ref(initialId || `wf-${crypto.randomUUID()}`);
  const enabled = ref(true);
  const savedEnabled = ref(true);
  const selectedId = ref("");
  const secretName = ref("");
  const secretValue = ref("");
  const fileMode = ref(false);
  const secretFileName = ref("");
  const secretFileData = ref("");
  const notice = ref("");
  const noticeError = ref(false);
  const noticeLink = ref(false);
  const busy = ref(false);
  const secretValueInput = templateRef("secretValueInput");
  const secretFileInput = templateRef("secretFileInput");
  const secretForm = templateRef("secretForm");
  const helpContent = templateRef("helpContent");
  const helpLoaded = ref(false);
  const helpLoading = ref(false);
  let validationTimer;

  const showNotice = (message, error = false, showRunsLink = false) => {
    notice.value = message;
    noticeError.value = error;
    noticeLink.value = showRunsLink;
  };

  const api = async (url, options = {}) => {
    const requestHeaders = {
      "X-Team-ID": selectedWorkspaceId.value,
      ...(options.headers || {}),
    };
    const response = await apiFetch(url, {
      ...options,
      credentials: "same-origin",
      headers: {
        accept: "application/json",
        ...(options.body ? { "content-type": "application/json" } : {}),
        ...requestHeaders,
      },
    });
    const body = response.status === 204 ? null : await response.json().catch(() => ({}));
    if (!response.ok) {
      throw new Error(body.error || `Request failed: ${response.status}`);
    }
    return body;
  };

  const run = async (action) => {
    if (busy.value) {
      return;
    }

    busy.value = true;

    try {
      await action();
    } catch (error) {
      showNotice(error.message, true);
    } finally {
      busy.value = false;
    }
  };

  const loadWorkflows = async () => {
    const { workspaces = [] } = await api("/api/v1/workspaces", { headers: { "X-Team-ID": "" } });
    const results = await Promise.all(
      workspaces.map(async (workspace) => {
        try {
          const data = await api("/api/v1/workflows", { headers: { "X-Team-ID": workspace.id } });
          return (data.workflows || []).map((workflow) => ({
            ...workflow,
            workspaceId: workspace.id,
            workspaceName: workspace.name,
          }));
        } catch (error) {
          console.error(`Unable to load workflows for workspace ${workspace.id}`, error);
          return null;
        }
      }),
    );
    workflows.value = results.filter(Boolean).flat();
    if (results.some((result) => result === null)) {
      showNotice("Some workspaces' workflows could not be loaded.", true);
    }
  };

  const loadSecrets = async () => {
    secrets.value = (await api("/api/v1/secrets")).secrets;
  };

  const persistWorkspaceSelection = (workspaceId) => {
    if (workspaceId) {
      localStorage.setItem("runner-team-id", workspaceId);
    } else {
      localStorage.removeItem("runner-team-id");
    }
    window.dispatchEvent(new CustomEvent("runner-team-changed", { detail: { teamId: workspaceId } }));
  };

  const loadWorkspaceOptions = async () => {
    workspacesLoading.value = true;
    try {
      const { workspaces: result = [] } = await api("/api/v1/workspaces", { headers: { "X-Team-ID": "" } });
      availableWorkspaces.value = result;
      const currentSelectionExists = result.some((workspace) => workspace.id === selectedWorkspaceId.value);
      if (!currentSelectionExists) {
        selectedWorkspaceId.value = result.length === 1 ? result[0].id : "";
      }
      persistWorkspaceSelection(selectedWorkspaceId.value);
    } finally {
      workspacesLoading.value = false;
    }
  };

  const setWorkspace = async (event) => {
    const workspaceId = event.target.value;
    if (!availableWorkspaces.value.some((workspace) => workspace.id === workspaceId)) {
      event.target.value = selectedWorkspaceId.value;
      return;
    }
    const sourceWorkspaceId = selectedWorkspaceId.value;
    if (selectedId.value && workspaceId !== sourceWorkspaceId) {
      await run(async () => {
        if (readOnly) {
          throw new Error("Revision snapshots cannot be moved between workspaces.");
        }
        await api(`/api/v1/workflows/${selectedId.value}/transfer`, {
          method: "POST",
          headers: { "X-Team-ID": sourceWorkspaceId },
          body: JSON.stringify({ targetWorkspaceId: workspaceId }),
        });
        selectedWorkspaceId.value = workspaceId;
        persistWorkspaceSelection(workspaceId);
        await openWorkflow(selectedId.value);
        showNotice("Draft moved to the selected workspace.");
      });
      return;
    }
    selectedWorkspaceId.value = workspaceId;
    persistWorkspaceSelection(workspaceId);
    if (initialId && !selectedId.value) {
      try {
        await openWorkflow(initialId);
      } catch (error) {
        showNotice(error.message, true);
      }
    }
  };

  const openWorkflow = async (id) => {
    const workflowUrl = initialRevision
      ? `/api/v1/workflows/${id}?revision=${initialRevision}`
      : `/api/v1/workflows/${id}`;
    const workflow = await api(workflowUrl);
    selectedId.value = workflow.id;
    workflowId.value = workflow.id;
    source.value = workflow.sourceYaml;
    savedSource.value = workflow.sourceYaml;
    enabled.value = workflow.enabled;
    savedEnabled.value = workflow.enabled;
    revision.value = workflow.revision || null;
  };

  const validateSource = async () => {
    return api("/api/v1/workflows/validate", {
      method: "POST",
      body: JSON.stringify({ sourceYaml: source.value }),
    });
  };

  const validate = (ms = 1000) => {
    if (page !== "editor") {
      return;
    }

    clearTimeout(validationTimer);
    validationTimer = setTimeout(() => {
      validation.value = { ...validation.value, running: true, error: "" };
      void validateSource()
        .then((result) => {
          validation.value = { ...result, running: false };
        })
        .catch((error) => {
          validation.value = { valid: false, running: false, error: error.message };
        });
    }, ms);
  };

  const save = () =>
    run(async () => {
      if (!availableWorkspaces.value.some((workspace) => workspace.id === selectedWorkspaceId.value)) {
        throw new Error("Choose a workspace before saving this workflow.");
      }
      const id = selectedId.value || workflowId.value;
      if (
        initialId &&
        id === selectedId.value &&
        source.value === savedSource.value &&
        enabled.value === savedEnabled.value
      ) {
        showNotice("No changes to save.");
        return;
      }
      const workflow = await api(`/api/v1/workflows/${id}`, {
        method: "PUT",
        body: JSON.stringify({ sourceYaml: source.value, enabled: enabled.value }),
      });
      selectedId.value = workflow.id;
      workflowId.value = workflow.id;
      savedSource.value = source.value;
      savedEnabled.value = enabled.value;
      revision.value = workflow.revision;
      showNotice(`Saved draft revision ${workflow.revision}.`);
      if (!initialId) {
        history.replaceState(
          null,
          "",
          `/ui/workflows/${workflow.id}?workspaceId=${encodeURIComponent(selectedWorkspaceId.value)}`,
        );
      }
    });
  const publish = () =>
    run(async () => {
      const id = workflowId.value.trim() || selectedId.value;
      if (!id) {
        throw new Error("Save a workflow before publishing it.");
      }
      const workflow = await api(`/api/v1/workflows/${id}/publish`, { method: "POST" });

      selectedId.value = workflow.id;
      revision.value = workflow.revision;
      showNotice(`Published revision ${workflow.revision}.`);
    });
  const runNow = () =>
    run(async () => {
      const id = workflowId.value.trim() || selectedId.value;
      if (!id) {
        throw new Error("Save the workflow before running it.");
      }
      if (source.value !== savedSource.value) {
        throw new Error("Save the latest draft before running it.");
      }
      const result = await api(`/api/v1/workflows/${id}/run`, {
        method: "POST",
        body: JSON.stringify({}),
      });
      showNotice(
        `Queued ${result.jobs.length} job${result.jobs.length === 1 ? "" : "s"} from revision ${result.revision}.`,
        false,
        true,
      );
    });
  const remove = () =>
    run(async () => {
      const id = workflowId.value.trim() || selectedId.value;
      if (!id || !confirm(`Delete ${id} and all of its revisions?`)) {
        return;
      }
      await api(`/api/v1/workflows/${id}`, { method: "DELETE" });

      navigateTo("/ui/workflows");
    });
  const saveSecret = () =>
    run(async () => {
      const name = secretName.value.trim().toUpperCase();
      if (!/^[A-Z][A-Z0-9_]*$/.test(name)) {
        throw new Error("Secret names must start with a letter and contain only letters, numbers, and underscores.");
      }
      secretName.value = name;
      if (!name || (fileMode.value ? !secretFileData.value : !secretValue.value)) {
        throw new Error(fileMode.value ? "Choose a file first." : "Set a secret value first.");
      }
      await api(`/api/v1/secrets/${name}`, {
        method: "PUT",
        body: JSON.stringify(
          fileMode.value
            ? { value: secretFileData.value, encoding: "base64", originalName: secretFileName.value }
            : { value: secretValue.value, encoding: "utf8" },
        ),
      });
      secretValue.value = "";
      secretFileName.value = "";
      secretFileData.value = "";
      fileMode.value = false;
      if (secretFileInput.value) {
        secretFileInput.value.value = "";
      }
      if (secretForm.value) {
        secretForm.value.open = false;
      }
      await loadSecrets();
      showNotice(`Saved ${name}.`);
    });
  const removeSecret = (requestedName = "") =>
    run(async () => {
      const name = (requestedName || secretName.value.trim()).toUpperCase();
      if (!name || !confirm(`Delete ${name}?`)) {
        return;
      }
      await api(`/api/v1/secrets/${name}`, { method: "DELETE" });

      if (secretName.value.trim().toUpperCase() === name) {
        secretName.value = "";
        secretValue.value = "";
        secretFileName.value = "";
        secretFileData.value = "";
        fileMode.value = false;
        if (secretFileInput.value) {
          secretFileInput.value.value = "";
        }
      }
      await loadSecrets();
      showNotice(`Deleted ${name}.`);
    });
  const setSource = (value) => {
    source.value = value;
    validate();
  };
  const setEnabled = async (event) => {
    const nextEnabled = event.target.checked;
    if (!selectedId.value || readOnly) {
      enabled.value = nextEnabled;
      return;
    }
    const previous = enabled.value;
    await run(async () => {
      await api(`/api/v1/workflows/${selectedId.value}/enabled`, {
        method: "PATCH",
        body: JSON.stringify({ enabled: nextEnabled }),
      });
      enabled.value = nextEnabled;
      savedEnabled.value = nextEnabled;
      showNotice(nextEnabled ? "Workflow enabled." : "Workflow disabled.");
    });
    if (noticeError.value) {
      enabled.value = previous;
      event.target.checked = previous;
    }
  };
  const setSecretName = (event) => {
    secretName.value = event.target.value;
  };
  const setSecretValue = (event) => {
    secretValue.value = event.target.value;
    fileMode.value = false;
    if (secretValue.value) {
      secretFileName.value = "";
      secretFileData.value = "";
      if (secretFileInput.value) {
        secretFileInput.value.value = "";
      }
    }
  };
  const setFileMode = (event) => {
    fileMode.value = event.target.checked;
    if (!fileMode.value) {
      secretFileName.value = "";
      secretFileData.value = "";
      if (secretFileInput.value) {
        secretFileInput.value.value = "";
      }
    } else {
      secretValue.value = "";
    }
  };
  const setSecretFile = async (event) => {
    const file = event.target.files?.[0];
    if (!file) {
      return;
    }
    const bytes = new Uint8Array(await file.arrayBuffer());
    let binary = "";
    for (let index = 0; index < bytes.length; index += 0x8000) {
      binary += String.fromCharCode(...bytes.subarray(index, index + 0x8000));
    }
    secretFileName.value = file.name;
    secretFileData.value = btoa(binary);
    secretValue.value = "";
  };
  const selectSecret = (name) => {
    secretName.value = name;
    secretValueInput.value?.focus();
  };
  const loadHelp = async (event) => {
    if (!event.target.open || helpLoaded.value || helpLoading.value || !helpContent.value) {
      return;
    }
    helpLoading.value = true;
    helpContent.value.textContent = "Loading workflow syntax help...";
    try {
      const response = await fetch("/ui/help?embed=1", { headers: { accept: "text/html" } });
      if (!response.ok) {
        throw new Error(`Help request failed: ${response.status}`);
      }
      const html = await response.text();
      const parsed = new DOMParser().parseFromString(html, "text/html");
      const sourceNodes = [...Array.from(parsed.head.querySelectorAll("style")), ...Array.from(parsed.body.childNodes)];
      const nodes = sourceNodes.map((node) => document.importNode(node, true));
      helpContent.value.replaceChildren(...nodes);
      helpLoaded.value = true;
    } catch (error) {
      helpContent.value.textContent = "Unable to load workflow syntax help.";
      console.error(error);
    } finally {
      helpLoading.value = false;
    }
  };

  const escapeRevisionHtml = (value) =>
    value.replace(
      /[&<>"']/g,
      (character) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[character] || "",
    );
  const renderRevisionDiff = (previousSource, currentSource) => {
    if (previousSource === null) {
      return `<span class="text-emerald-300">+ ${escapeRevisionHtml(currentSource)}</span>\n`;
    }
    return diffLines(previousSource, currentSource)
      .map((part) => {
        const className = part.added
          ? "text-emerald-300 bg-emerald-500/10"
          : part.removed
            ? "text-rose-300 bg-rose-500/10"
            : "text-gray-300";
        const prefix = part.added ? "+ " : part.removed ? "- " : "  ";
        return part.value
          .split("\n")
          .filter((line, index, lines) => index < lines.length - 1 || line)
          .map((line) => `<span class="block ${className}">${prefix}${escapeRevisionHtml(line)}</span>`)
          .join("");
      })
      .join("");
  };
  const openRevisionDialog = async () => {
    if (!revision.value) {
      return;
    }
    revisionNumber.value = revision.value;
    revisionDiffHtml.value = "";
    revisionError.value = "";
    revisionDialogOpen.value = true;
    await loadRevisionDiff(revision.value);
  };
  const closeRevisionDialog = () => {
    revisionDialogOpen.value = false;
  };
  const loadRevisionDiff = async (number) => {
    revisionLoading.value = true;
    revisionError.value = "";
    try {
      const current = await api(`/api/v1/workflows/${selectedId.value}?revision=${number}`);
      const previous = number > 1 ? await api(`/api/v1/workflows/${selectedId.value}?revision=${number - 1}`) : null;
      revisionDiffHtml.value = renderRevisionDiff(previous?.sourceYaml ?? null, current.sourceYaml);
    } catch (error) {
      revisionError.value = error.message;
    } finally {
      revisionLoading.value = false;
    }
  };
  const navigateRevision = async (offset) => {
    if (!selectedId.value || revisionLoading.value) {
      return;
    }
    const target = revisionNumber.value + offset;
    if (target < 1 || target > revision.value) {
      return;
    }
    revisionNumber.value = target;
    await loadRevisionDiff(target);
  };
  const openAiHelp = () => {
    aiRequest.value = "";
    aiError.value = "";
    aiSuggestion.value = "";
    aiDiffHtml.value = "";
    aiDialogOpen.value = true;
  };
  const closeAiHelp = () => {
    if (!aiLoading.value) {
      aiDialogOpen.value = false;
    }
  };
  const requestAiHelp = async () => {
    if (!aiRequest.value.trim() || aiLoading.value) {
      return;
    }
    aiLoading.value = true;
    aiError.value = "";
    aiDiffHtml.value = "";
    try {
      const response = await apiFetch("/api/v1/ai/workflow-help", {
        method: "POST",
        credentials: "same-origin",
        headers: { accept: "text/event-stream", "content-type": "application/json" },
        body: JSON.stringify({ sourceYaml: source.value, request: aiRequest.value }),
      });
      if (!response.ok) {
        const error = await response.json().catch(() => ({}));
        throw new Error(error.error || `AI help failed: ${response.status}`);
      }
      const reader = response.body.getReader();
      const decoder = new TextDecoder();
      let buffer = "";
      let suggestion = "";
      while (true) {
        const chunk = await reader.read();
        if (chunk.done) {
          break;
        }
        buffer += decoder.decode(chunk.value, { stream: true });
        const events = buffer.split("\n\n");
        buffer = events.pop() || "";
        for (const event of events) {
          const line = event.split("\n").find((value) => value.startsWith("data: "));
          if (!line) {
            continue;
          }
          const data = JSON.parse(line.slice(6));
          if (data.error) {
            throw new Error(data.error);
          }
          if (data.delta) {
            suggestion += data.delta;
          }
        }
      }
      suggestion = suggestion
        .replace(/^```(?:yaml|yml)?\s*/i, "")
        .replace(/\s*```$/i, "")
        .trim();
      if (!source.value.trim()) {
        source.value = suggestion;
        aiDialogOpen.value = false;
        validate();
      } else {
        aiSuggestion.value = suggestion;
        aiDiffHtml.value = renderRevisionDiff(source.value, suggestion);
      }
    } catch (error) {
      aiError.value = error.message;
    } finally {
      aiLoading.value = false;
    }
  };
  const acceptAiSuggestion = () => {
    source.value = aiSuggestion.value;
    aiDialogOpen.value = false;
    validate();
  };
  const rejectAiSuggestion = () => {
    aiSuggestion.value = "";
    aiDiffHtml.value = "";
  };

  onDestroy(() => clearTimeout(validationTimer));

  onInit(() => {
    const loadEditor = async () => {
      await loadWorkspaceOptions();
      if (initialId && selectedWorkspaceId.value) {
        await openWorkflow(initialId);
      }
    };
    const loadPage = page === "editor" ? loadEditor() : page === "secrets" ? loadSecrets() : loadWorkflows();
    loadPage.catch((error) => showNotice(error.message, true));
  });

  return {
    page,
    workflows,
    availableWorkspaces,
    workspacesLoading,
    selectedWorkspaceId,
    secrets,
    source,
    validation,
    revision,
    revisionDialogOpen,
    revisionNumber,
    revisionDiffHtml,
    revisionError,
    revisionLoading,
    aiDialogOpen,
    aiRequest,
    aiLoading,
    aiError,
    aiDiffHtml,
    workflowId,
    enabled,
    readOnly,
    selectedId,
    secretName,
    secretValue,
    fileMode,
    secretFileName,
    secretFileData,
    notice,
    noticeError,
    noticeLink,
    busy,
    validate,
    save,
    publish,
    runNow,
    remove,
    saveSecret,
    removeSecret,
    setSource,
    setWorkspace,
    setEnabled,
    setSecretName,
    setSecretValue,
    setFileMode,
    setSecretFile,
    selectSecret,
    loadHelp,
    openRevisionDialog,
    closeRevisionDialog,
    navigateRevision,
    openAiHelp,
    closeAiHelp,
    requestAiHelp,
    acceptAiSuggestion,
    rejectAiSuggestion,
  };
}
