import { computed, getElement, onDestroy, onInit, ref } from "@li3/web";
import { AnsiUp } from "ansi_up";
import { marked } from "marked";
import { apiFetch } from "@app/api-client.mjs";
import { loadTimezonePreference } from "@app/preferences.mjs";
import { navigateTo } from "@app/app-router.mjs";
import { formatTimestampedLogLine } from "@app/timezone-format.mjs";

export default function setup() {
  const routeParams = getElement().routeParams || {};
  const jobId = routeParams.jobId || window.location.pathname.split("/").filter(Boolean).pop() || "";
  const report = ref({ jobId, steps: [], artifacts: [], inputs: {} });
  const stepAttempts = ref([]);
  const attemptsState = ref("loading");
  const attemptsError = ref("");
  let attemptsJobId = "";
  let loadingAttemptsId = "";
  let attemptsController = null;
  const previousRuns = ref([]);
  const aiMessages = ref([]);
  const aiStepId = ref("");
  const aiQuestion = ref("");
  const aiError = ref("");
  const aiLoading = ref(false);
  const manualRestartOpen = ref(false);
  const manualRestartLoading = ref(false);
  const restartLoading = ref(false);
  const restartError = ref("");
  const manualInputs = ref([]);
  let previousRunsLoaded = false;
  const selectedStep = ref(0);
  const detailTab = ref("logs");
  const logSearch = ref("");
  const wrapLogs = ref(true);
  const detailTabs = computed(() =>
    [
      { id: "logs", label: "Logs & steps", icon: "terminal", visible: Boolean(report.value.canViewLogs) },
      { id: "inputs", label: "Inputs", icon: "code", visible: Boolean(report.value.canViewInputs) },
      { id: "artifacts", label: "Artifacts", icon: "box", visible: Boolean(report.value.canViewArtifacts) },
      { id: "history", label: "History", icon: "list-clock", visible: true },
      {
        id: "source",
        label: "Workflow source",
        icon: "file-code",
        visible: Boolean(report.value.canViewLogs && report.value.workflowSourceYaml),
      },
    ].map((tab) => ({ ...tab, isActive: detailTab.value === tab.id })),
  );
  const now = ref(Date.now());
  const timezone = ref(Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC");
  const ansiUp = new AnsiUp();
  ansiUp.use_classes = false;
  let eventSource;
  let refreshTimer;
  let clockTimer;
  let refreshing = false;
  let refreshPending = false;
  const cancelling = ref(false);

  const formatDuration = (milliseconds) => {
    const value = Number(milliseconds);
    if (!Number.isFinite(value) || value < 0) {
      return "—";
    }
    const seconds = Math.floor(value / 1000);
    const minutes = Math.floor(seconds / 60);
    const hours = Math.floor(minutes / 60);
    const remainingMinutes = minutes % 60;
    return `${hours ? `${hours}h ` : ""}${remainingMinutes ? `${remainingMinutes}m ` : ""}${seconds % 60}s`;
  };
  const parseTimestamp = (value) => {
    if (!value) {
      return Number.NaN;
    }
    const text = String(value).trim();
    const normalized = text.includes("T") ? text : text.replace(" ", "T");
    const hasTimezone = /(?:Z|[+-]\d{2}:?\d{2})$/i.test(normalized);
    return Date.parse(hasTimezone ? normalized : `${normalized}Z`);
  };

  const active = computed(() => ["pending", "running"].includes(report.value.status));
  const steps = computed(() =>
    (report.value.steps || []).map((item, index) => ({
      ...item,
      index,
      isSelected: Number(selectedStep.value) === Number(index),
    })),
  );
  const callInstances = computed(() =>
    (report.value.callInstances || []).map((call) => ({
      ...call,
      childSteps: steps.value.filter((step) => (call.stepIds || []).includes(step.id)),
    })),
  );
  const attemptsForStep = (step) => stepAttempts.value.filter((attempt) => String(attempt.step_id) === String(step.id));
  const hasUnrecordedCompletion = computed(
    () =>
      report.value.canViewLogs &&
      !["pending", "running"].includes(report.value.status) &&
      stepAttempts.value.some((attempt) => attempt.status === "interrupted_or_unknown"),
  );
  const loadStepAttempts = async (id = report.value.jobId) => {
    if (
      loadingAttemptsId === String(id) ||
      !report.value.canViewLogs ||
      !id ||
      (attemptsJobId === String(id) && attemptsState.value === "loaded")
    ) {
      return;
    }
    loadingAttemptsId = String(id);
    attemptsState.value = "loading";
    attemptsError.value = "";
    const controller = new AbortController();
    attemptsController = controller;
    const timeout = setTimeout(() => controller.abort(), 15_000);
    try {
      const response = await apiFetch(`/api/v1/jobs/${encodeURIComponent(id)}/step-attempts`, {
        headers: { accept: "application/json" },
        signal: controller.signal,
      });
      if (!response.ok) {
        throw new Error(`Execution attempts unavailable (${response.status})`);
      }
      const data = await response.json();
      if (String(report.value.jobId) === String(id) && report.value.canViewLogs) {
        stepAttempts.value = Array.isArray(data.attempts) ? data.attempts : [];
        attemptsState.value = "loaded";
      }
    } catch {
      if (String(report.value.jobId) === String(id) && report.value.canViewLogs) {
        attemptsState.value = "error";
        attemptsError.value = "Execution attempts could not be loaded.";
      }
    } finally {
      clearTimeout(timeout);
      if (loadingAttemptsId === String(id)) {
        loadingAttemptsId = "";
      }
      if (attemptsController === controller) {
        attemptsController = null;
      }
    }
  };
  const selectedStepReport = computed(() => report.value.steps?.[selectedStep.value]);
  const inputsJson = computed(() => JSON.stringify(report.value.inputs || {}, null, 2));
  const originalInputsJson = computed(() => JSON.stringify(report.value.inputs || {}, null, 2));
  const timing = computed(() => {
    if (report.value.status === "pending") {
      return "—";
    }
    if (report.value.status === "running") {
      return formatDuration(Math.max(0, now.value - parseTimestamp(report.value.startedAt)));
    }
    return formatDuration(report.value.durationMs);
  });
  const failedStepMessage = computed(() => {
    const failedStep = report.value.steps?.find((item) => item.status === "failed");
    return failedStep
      ? `${failedStep.name} failed. Review its log output below.`
      : "A step failed. Review its log output below.";
  });
  const upper = (value) => String(value || "").toUpperCase();
  const attemptStatusLabel = (status) =>
    status === "interrupted_or_unknown" ? "Completion not recorded" : upper(status);
  const selectStep = (index) => {
    selectedStep.value = Number(index);
  };
  const formatDate = (value) => {
    if (!value) {
      return "—";
    }
    const text = String(value);
    const date = new Date(text.includes("T") ? text : `${text.replace(" ", "T")}Z`);
    if (Number.isNaN(date.getTime())) {
      return "—";
    }
    return new Intl.DateTimeFormat(undefined, {
      dateStyle: "medium",
      timeStyle: "short",
      timeZone: timezone.value,
    }).format(date);
  };
  const copyLogs = async () => {
    const step = selectedStepReport.value;
    const entries = [];
    if (step?.logContent) {
      entries.push(`Current step log (${step.id}):\n${step.logContent}`);
    }
    for (const attempt of attemptsForStep(step || {})) {
      if (attempt.log_content) {
        entries.push(`Attempt ${attempt.attempt} (${attempt.status}):\n${attempt.log_content}`);
      }
    }
    const content = entries.join("\n\n");
    if (content && navigator.clipboard?.writeText) {
      await navigator.clipboard.writeText(content);
    }
  };
  const copyRunUrl = async () => {
    if (navigator.clipboard?.writeText) {
      await navigator.clipboard.writeText(window.location.href);
    }
  };
  const downloadLogs = () => {
    const content = (report.value.steps || [])
      .map(
        (step) =>
          `===== ${step.name || step.id || "Step"} (${String(step.status || "unknown").toUpperCase()}) =====\n${step.logContent || ""}`,
      )
      .join("\n\n");
    const link = document.createElement("a");
    link.href = URL.createObjectURL(new Blob([content], { type: "text/plain;charset=utf-8" }));
    link.download = `run-${report.value.jobId}-logs.txt`;
    link.click();
    URL.revokeObjectURL(link.href);
  };
  const selectDetailTab = (tab) => {
    detailTab.value = tab;
  };
  const setLogSearch = (event) => {
    logSearch.value = event.target.value;
  };
  const toggleLogWrap = () => {
    wrapLogs.value = !wrapLogs.value;
  };
  const successfulSteps = computed(() => report.value.steps?.filter((item) => item.status === "success").length || 0);
  const totalSteps = computed(() => report.value.steps?.length || 0);
  const totalDuration = computed(() => formatDuration(report.value.durationMs));
  const stepStatusLabel = computed(() => {
    const current = report.value.steps?.[selectedStep.value];
    return current?.status === "failed" ? "exit code 1" : upper(current?.status);
  });
  const loadTimezone = async () => {
    const preference = await loadTimezonePreference();
    if (preference.timezone) {
      timezone.value = preference.timezone;
    }
    if (preference.legacyError) {
      console.warn("Timezone preference unavailable; using system timezone", preference.legacyError);
    }
  };
  const artifactUrl = (path) => `/api/v1/runs/${report.value.jobId}/artifacts/${encodeURIComponent(path)}`;
  const downloadArtifact = async (event, path) => {
    event.preventDefault();
    const response = await apiFetch(artifactUrl(path));
    if (!response.ok) {
      return;
    }
    const link = document.createElement("a");
    link.href = URL.createObjectURL(await response.blob());
    link.download = path.split("/").pop() || "artifact";
    link.click();
    URL.revokeObjectURL(link.href);
  };
  const loadPreviousRuns = async () => {
    if (previousRunsLoaded || !report.value.parentId) {
      return;
    }
    const lineage = [];
    const visited = new Set();
    let parentId = report.value.parentId;
    while (parentId && !visited.has(String(parentId)) && lineage.length < 50) {
      visited.add(String(parentId));
      const response = await apiFetch(`/api/v1/runs/${parentId}`, { headers: { accept: "application/json" } });
      if (!response.ok) {
        throw new Error(`Previous run request failed: ${response.status}`);
      }

      const parent = await response.json();
      lineage.push({ id: parent.jobId, status: parent.status, startedAt: parent.startedAt });
      parentId = parent.parentId;
    }
    previousRuns.value = lineage;
    previousRunsLoaded = true;
  };
  const stepLog = (step) => {
    if (step.status === "skipped") {
      return "";
    }
    if (step.status === "running") {
      return '<span class="text-indigo-400">Step is running. Logs will appear after it finishes.</span>';
    }
    if (step.status === "pending") {
      return '<span class="text-gray-500">Waiting to run.</span>';
    }
    if (step.logContent) {
      const query = logSearch.value.trim().toLocaleLowerCase();
      const lines = step.logContent.split("\n");
      const matchingLines = query ? lines.filter((line) => line.toLocaleLowerCase().includes(query)) : lines;
      if (query && matchingLines.length === 0) {
        return '<span class="text-gray-400">No matching log lines.</span>';
      }
      const localized = matchingLines
        .map((line) => formatTimestampedLogLine(escapeLogHtml(line), timezone.value))
        .join("\n");
      return ansiUp.ansi_to_html(localized);
    }
    return '<span class="text-gray-500">(No terminal log output recorded for this step)</span>';
  };
  const attemptLog = (attempt) => {
    const query = logSearch.value.trim().toLocaleLowerCase();
    const lines = String(attempt.log_content || "").split("\n");
    const matchingLines = query ? lines.filter((line) => line.toLocaleLowerCase().includes(query)) : lines;
    if (query && matchingLines.length === 0) {
      return '<span class="text-gray-400">No matching log lines.</span>';
    }
    return ansiUp.ansi_to_html(
      matchingLines.map((line) => formatTimestampedLogLine(escapeLogHtml(line), timezone.value)).join("\n"),
    );
  };
  const escapeLogHtml = (value) =>
    String(value)
      .replaceAll("&", "&amp;")
      .replaceAll("<", "&lt;")
      .replaceAll(">", "&gt;")
      .replaceAll('"', "&quot;")
      .replaceAll("'", "&#39;");
  const sanitizeAiHtml = (html) => {
    const parsed = new DOMParser().parseFromString(html, "text/html");
    parsed.querySelectorAll("script,style,iframe,object,embed,form").forEach((node) => node.remove());
    parsed.querySelectorAll("*").forEach((element) => {
      [...element.attributes].forEach((attribute) => {
        if (attribute.name.toLowerCase().startsWith("on")) {
          element.removeAttribute(attribute.name);
        }
        if (["href", "src"].includes(attribute.name.toLowerCase()) && /^(javascript|data):/i.test(attribute.value)) {
          element.removeAttribute(attribute.name);
        }
      });
    });
    return parsed.body.innerHTML;
  };
  const renderAiMarkdown = (content) => sanitizeAiHtml(marked.parse(content));
  const askAi = async (step, event) => {
    event.stopPropagation();
    aiStepId.value = step.id;
    aiMessages.value = [];
    aiQuestion.value = "";
    await requestAiHelp(step.id, "Please explain why this step failed and what I should do next.");
  };
  const requestAiHelp = async (stepId, question) => {
    aiLoading.value = true;
    aiError.value = "";
    try {
      const response = await apiFetch(`/api/v1/runs/${report.value.jobId}/ai-help`, {
        method: "POST",
        headers: { accept: "application/json", "content-type": "application/json" },
        body: JSON.stringify({ stepId, question, conversation: aiMessages.value }),
      });
      if (!response.ok) {
        const data = await response.json().catch(() => ({}));
        throw new Error(data.error || `AI help failed: ${response.status}`);
      }
      aiMessages.value = [...aiMessages.value, { role: "user", content: question }, { role: "assistant", content: "" }];
      const reader = response.body.getReader();
      const decoder = new TextDecoder();
      let buffer = "";
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
          if (data.delta) {
            const messages = [...aiMessages.value];
            messages[messages.length - 1] = {
              ...messages[messages.length - 1],
              content: messages[messages.length - 1].content + data.delta,
            };
            aiMessages.value = messages;
          }
          if (data.error) {
            throw new Error(data.error);
          }
        }
      }
      const messages = [...aiMessages.value];
      const answer = messages.at(-1);
      if (answer) {
        messages[messages.length - 1] = { ...answer, html: renderAiMarkdown(answer.content) };
      }
      aiMessages.value = messages;
    } catch (error) {
      aiError.value = error.message;
    } finally {
      aiLoading.value = false;
    }
  };
  const askFollowup = async () => {
    const question = aiQuestion.value.trim();
    if (!question || !aiStepId.value) {
      return;
    }
    aiQuestion.value = "";
    await requestAiHelp(aiStepId.value, question);
  };
  const restartJob = async () => {
    if (restartLoading.value) {
      return;
    }
    restartLoading.value = true;
    restartError.value = "";
    try {
      const response = await apiFetch(`/api/v1/jobs/${report.value.jobId}/restart`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ inputs: report.value.inputs || {} }),
      });
      const result = await response.json().catch(() => ({}));
      if (!response.ok) {
        throw new Error(result.error || `Restart failed (${response.status})`);
      }
      if (result.id === undefined || result.id === null) {
        throw new Error("Restart failed: the server did not return a new run ID");
      }
      navigateTo(`/ui/runs/${result.id}`);
    } catch (error) {
      restartError.value = error instanceof Error ? error.message : "Restart failed. Please try again.";
    } finally {
      restartLoading.value = false;
    }
  };
  const openManualRestart = (event) => {
    event.preventDefault();
    event.stopPropagation();
    manualInputs.value = [{ key: "", value: "" }];
    manualRestartOpen.value = true;
  };
  const closeManualRestart = () => {
    manualRestartOpen.value = false;
  };
  const addManualInput = () => {
    manualInputs.value = [...manualInputs.value, { key: "", value: "" }];
  };
  const removeManualInput = (entry) => {
    manualInputs.value = manualInputs.value.filter((item) => item !== entry);
  };
  const setManualKey = (entry, event) => {
    entry.key = event.target.value;
    manualInputs.value = [...manualInputs.value];
  };
  const setManualValue = (entry, event) => {
    entry.value = event.target.value;
    manualInputs.value = [...manualInputs.value];
  };
  const restartWithInputs = async () => {
    const inputs = Object.fromEntries(
      manualInputs.value.filter((entry) => entry.key.trim()).map((entry) => [entry.key.trim(), entry.value]),
    );
    manualRestartLoading.value = true;
    try {
      const response = await apiFetch(`/api/v1/jobs/${report.value.jobId}/restart`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ inputs }),
      });
      const result = await response.json().catch(() => ({}));
      if (!response.ok) {
        throw new Error(result.error || `Restart failed (${response.status})`);
      }
      const { id } = result;
      if (id === undefined || id === null) {
        throw new Error("Restart failed: the server did not return a new run ID");
      }
      navigateTo(`/ui/runs/${id}`);
    } catch (error) {
      aiError.value = error.message;
    } finally {
      manualRestartLoading.value = false;
    }
  };
  const cancelJob = async () => {
    if (cancelling.value || report.value.status !== "running") {
      return;
    }
    cancelling.value = true;
    try {
      const response = await apiFetch(`/api/v1/jobs/${report.value.jobId}/cancel`, { method: "POST" });
      if (!response.ok) {
        throw new Error(`Cancel failed: ${response.status}`);
      }

      await refreshRun();
    } catch (error) {
      console.error(error);
    } finally {
      cancelling.value = false;
    }
  };
  const refreshRun = async () => {
    if (refreshing) {
      refreshPending = true;
      return;
    }
    refreshing = true;

    try {
      const response = await apiFetch(`/api/v1/runs/${jobId}`, {
        headers: { accept: "application/json" },
      });
      if (!response.ok) {
        throw new Error(`Run refresh failed: ${response.status}`);
      }
      const previousStatus = report.value.status;
      const nextReport = await response.json();
      report.value = nextReport;
      if (nextReport.canViewLogs) {
        if (attemptsJobId !== String(nextReport.jobId)) {
          attemptsJobId = String(nextReport.jobId);
          stepAttempts.value = [];
          attemptsState.value = "loading";
        }
        void loadStepAttempts(nextReport.jobId);
      } else {
        attemptsController?.abort();
        stepAttempts.value = [];
        attemptsJobId = "";
        attemptsState.value = "loaded";
        attemptsError.value = "";
      }
      if (!detailTabs.value.find((tab) => tab.id === detailTab.value && tab.visible)) {
        detailTab.value = detailTabs.value.find((tab) => tab.visible)?.id || "history";
      }
      if (previousStatus !== "failed" && nextReport.status === "failed") {
        const failedIndex = (nextReport.steps || []).findIndex((step) => step.status === "failed");
        if (failedIndex >= 0) {
          selectedStep.value = failedIndex;
        }
      }
      document.title = `Run #${nextReport.jobId} - ${nextReport.workflowName}`;
      void loadPreviousRuns();
      if (
        ["pending", "running"].includes(previousStatus) &&
        ["success", "failed"].includes(nextReport.status) &&
        "Notification" in window &&
        "serviceWorker" in navigator &&
        Notification.permission === "granted" &&
        localStorage.getItem("runner-notifications") === "enabled"
      ) {
        const registration = await navigator.serviceWorker.ready;
        await registration.showNotification(
          nextReport.status === "success" ? `Job #${nextReport.jobId} succeeded` : `Job #${nextReport.jobId} failed`,
          {
            body: `${nextReport.workflowName} finished with status ${nextReport.status}.`,
            icon: "/assets/app-icon.svg",
            badge: "/assets/app-icon.svg",
            tag: `runner-job-${nextReport.jobId}`,
            renotify: true,
            data: { url: `/ui/runs/${nextReport.jobId}` },
          },
        );
      }
    } catch (error) {
      console.error(error);
    } finally {
      refreshing = false;
      if (refreshPending) {
        refreshPending = false;
        void refreshRun();
        void loadTimezone().catch((error) => console.error("Unable to load timezone preference", error));
      }
    }
  };
  const handleJobChange = (event) => {
    const data = JSON.parse(event.data || "{}");
    if (!data.jobId || String(data.jobId) === String(report.value.jobId)) {
      void refreshRun();
    }
  };
  const handleOutsideRestartMenu = (event) => {
    const menu = document.querySelector("[data-restart-menu]");
    if (menu?.open && !menu.contains(event.target)) {
      menu.open = false;
    }
  };

  onInit(() => {
    document.addEventListener("pointerdown", handleOutsideRestartMenu);
    void refreshRun();
    if ("serviceWorker" in navigator) {
      navigator.serviceWorker.register("/assets/service-worker.js", { scope: "/ui/" }).catch((error) => {
        console.error("Service worker registration failed", error);
      });
    }
    eventSource = new EventSource(
      `/api/v1/events?teamId=${encodeURIComponent(localStorage.getItem("runner-team-id") || "")}`,
    );
    eventSource.addEventListener("jobs.changed", handleJobChange);
    refreshTimer = setInterval(() => {
      if (active.value) {
        void refreshRun();
      }
    }, 60000);
    clockTimer = setInterval(() => {
      now.value = Date.now();
    }, 1000);
  });
  onDestroy(() => {
    document.removeEventListener("pointerdown", handleOutsideRestartMenu);
    eventSource?.close();
    clearInterval(refreshTimer);
    clearInterval(clockTimer);
  });

  return {
    report,
    attemptsForStep,
    hasUnrecordedCompletion,
    attemptLog,
    attemptsState,
    attemptsError,
    retryStepAttempts: () => loadStepAttempts(),
    previousRuns,
    manualRestartOpen,
    manualRestartLoading,
    restartLoading,
    restartError,
    manualInputs,
    aiMessages,
    aiStepId,
    aiQuestion,
    aiError,
    aiLoading,
    inputsJson,
    originalInputsJson,
    timing,
    failedStepMessage,
    upper,
    attemptStatusLabel,
    timezone,
    formatDate,
    artifactUrl,
    downloadArtifact,
    stepLog,
    steps,
    callInstances,
    selectedStepReport,
    detailTabs,
    askAi,
    askFollowup,
    restartJob,
    openManualRestart,
    closeManualRestart,
    addManualInput,
    removeManualInput,
    setManualKey,
    setManualValue,
    restartWithInputs,
    cancelJob,
    cancelling,
    selectedStep,
    successfulSteps,
    totalSteps,
    totalDuration,
    stepStatusLabel,
    selectStep,
    detailTab,
    selectDetailTab,
    logSearch,
    setLogSearch,
    wrapLogs,
    toggleLogWrap,
    copyLogs,
    copyRunUrl,
    downloadLogs,
    formatDuration,
  };
}
