import { computed, onDestroy, onInit, ref } from "@li3/web";
import { AnsiUp } from "ansi_up";
import { marked } from "marked";
import { apiFetch } from "@app/api-client.mjs";
import { formatTimestampedLogLine } from "@app/timezone-format.mjs";

export default function setup() {
  const jobId = window.location.pathname.split("/").filter(Boolean).pop() || "";
  const report = ref({ jobId, steps: [], artifacts: [], inputs: {} });
  const previousRuns = ref([]);
  const aiMessages = ref([]);
  const aiStepId = ref("");
  const aiQuestion = ref("");
  const aiError = ref("");
  const aiLoading = ref(false);
  const manualRestartOpen = ref(false);
  const manualRestartLoading = ref(false);
  const manualInputs = ref([]);
  let previousRunsLoaded = false;
  const selectedStep = ref(0);
  const detailTab = ref("logs");
  const logSearch = ref("");
  const wrapLogs = ref(true);
  const isAdmin = ref(false);
  const detailTabs = computed(() =>
    [
      { id: "logs", label: "Logs & steps", icon: "terminal" },
      { id: "inputs", label: "Inputs", icon: "code" },
      { id: "artifacts", label: "Artifacts", icon: "box" },
      { id: "history", label: "History", icon: "list-clock" },
      { id: "source", label: "Workflow source", icon: "file-code" },
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
    if (!Number.isFinite(value) || value < 0) return "—";
    const seconds = Math.floor(value / 1000);
    const minutes = Math.floor(seconds / 60);
    const hours = Math.floor(minutes / 60);
    const remainingMinutes = minutes % 60;
    return `${hours ? `${hours}h ` : ""}${remainingMinutes ? `${remainingMinutes}m ` : ""}${seconds % 60}s`;
  };
  const parseTimestamp = (value) => {
    if (!value) return Number.NaN;
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
  const selectedStepReport = computed(() => report.value.steps?.[selectedStep.value]);
  const inputsJson = computed(() => JSON.stringify(report.value.inputs || {}, null, 2));
  const originalInputsJson = computed(() => JSON.stringify(report.value.inputs || {}, null, 2));
  const timing = computed(() => {
    if (report.value.status === "pending") return "—";
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
  const selectStep = (index) => {
    selectedStep.value = Number(index);
  };
  const formatDate = (value) => {
    if (!value) return "—";
    const text = String(value);
    const date = new Date(text.includes("T") ? text : `${text.replace(" ", "T")}Z`);
    if (Number.isNaN(date.getTime())) return "—";
    return new Intl.DateTimeFormat(undefined, {
      dateStyle: "medium",
      timeStyle: "short",
      timeZone: timezone.value,
    }).format(date);
  };
  const copyLogs = async () => {
    const content = selectedStepReport.value?.logContent;
    if (content && navigator.clipboard?.writeText) await navigator.clipboard.writeText(content);
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
    const response = await apiFetch("/api/preferences", { headers: { accept: "application/json" } });
    if (!response.ok) throw new Error(`Loading timezone preference failed: ${response.status}`);
    const preferences = await response.json();
    if (preferences.timezone) timezone.value = preferences.timezone;
  };
  const loadAdminRole = async () => {
    const response = await apiFetch("/api/session", { headers: { accept: "application/json" } });
    if (!response.ok) return;
    const session = await response.json();
    isAdmin.value = session.user?.role === "admin";
  };
  const artifactUrl = (path) => `/api/runs/${report.value.jobId}/artifacts/${encodeURIComponent(path)}`;
  const downloadArtifact = async (event, path) => {
    event.preventDefault();
    const response = await apiFetch(artifactUrl(path));
    if (!response.ok) return;
    const link = document.createElement("a");
    link.href = URL.createObjectURL(await response.blob());
    link.download = path.split("/").pop() || "artifact";
    link.click();
    URL.revokeObjectURL(link.href);
  };
  const loadPreviousRuns = async () => {
    if (previousRunsLoaded || !report.value.parentId) return;
    const lineage = [];
    const visited = new Set();
    let parentId = report.value.parentId;
    while (parentId && !visited.has(String(parentId)) && lineage.length < 50) {
      visited.add(String(parentId));
      const response = await apiFetch(`/api/runs/${parentId}`, { headers: { accept: "application/json" } });
      if (!response.ok) throw new Error(`Previous run request failed: ${response.status}`);
      const parent = await response.json();
      lineage.push({ id: parent.jobId, status: parent.status, startedAt: parent.startedAt });
      parentId = parent.parentId;
    }
    previousRuns.value = lineage;
    previousRunsLoaded = true;
  };
  const stepLog = (step) => {
    if (step.status === "skipped") return "";
    if (step.status === "running")
      return '<span class="text-indigo-400">Step is running. Logs will appear after it finishes.</span>';
    if (step.status === "pending") return '<span class="text-gray-500">Waiting to run.</span>';
    if (step.logContent) {
      const query = logSearch.value.trim().toLocaleLowerCase();
      const lines = step.logContent.split("\n");
      const matchingLines = query ? lines.filter((line) => line.toLocaleLowerCase().includes(query)) : lines;
      if (query && matchingLines.length === 0) return '<span class="text-gray-400">No matching log lines.</span>';
      const localized = matchingLines.map((line) => formatTimestampedLogLine(line, timezone.value)).join("\n");
      return ansiUp.ansi_to_html(localized);
    }
    return '<span class="text-gray-500">(No terminal log output recorded for this step)</span>';
  };
  const sanitizeAiHtml = (html) => {
    const parsed = new DOMParser().parseFromString(html, "text/html");
    parsed.querySelectorAll("script,style,iframe,object,embed,form").forEach((node) => node.remove());
    parsed.querySelectorAll("*").forEach((element) => {
      [...element.attributes].forEach((attribute) => {
        if (attribute.name.toLowerCase().startsWith("on")) element.removeAttribute(attribute.name);
        if (["href", "src"].includes(attribute.name.toLowerCase()) && /^(javascript|data):/i.test(attribute.value))
          element.removeAttribute(attribute.name);
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
      const response = await apiFetch(`/api/runs/${report.value.jobId}/ai-help`, {
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
        if (chunk.done) break;
        buffer += decoder.decode(chunk.value, { stream: true });
        const events = buffer.split("\n\n");
        buffer = events.pop() || "";
        for (const event of events) {
          const line = event.split("\n").find((value) => value.startsWith("data: "));
          if (!line) continue;
          const data = JSON.parse(line.slice(6));
          if (data.delta) {
            const messages = [...aiMessages.value];
            messages[messages.length - 1] = {
              ...messages[messages.length - 1],
              content: messages[messages.length - 1].content + data.delta,
            };
            aiMessages.value = messages;
          }
          if (data.error) throw new Error(data.error);
        }
      }
      const messages = [...aiMessages.value];
      const answer = messages.at(-1);
      if (answer) messages[messages.length - 1] = { ...answer, html: renderAiMarkdown(answer.content) };
      aiMessages.value = messages;
    } catch (error) {
      aiError.value = error.message;
    } finally {
      aiLoading.value = false;
    }
  };
  const askFollowup = async () => {
    const question = aiQuestion.value.trim();
    if (!question || !aiStepId.value) return;
    aiQuestion.value = "";
    await requestAiHelp(aiStepId.value, question);
  };
  const restartJob = async () => {
    const response = await apiFetch(`/restart/${report.value.jobId}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ inputs: report.value.inputs || {} }),
    });
    if (response.ok) {
      const { id } = await response.json();
      location.href = `/runs/${id}`;
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
      const response = await apiFetch(`/restart/${report.value.jobId}`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ inputs }),
      });
      if (!response.ok) throw new Error(`Restart failed: ${response.status}`);
      const { id } = await response.json();
      location.href = `/runs/${id}`;
    } catch (error) {
      aiError.value = error.message;
    } finally {
      manualRestartLoading.value = false;
    }
  };
  const cancelJob = async () => {
    if (cancelling.value || report.value.status !== "running") return;
    cancelling.value = true;
    try {
      const response = await apiFetch(`/api/jobs/${report.value.jobId}/cancel`, { method: "POST" });
      if (!response.ok) throw new Error(`Cancel failed: ${response.status}`);
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
      const response = await apiFetch(`/api/runs/${jobId}`, {
        headers: { accept: "application/json" },
      });
      if (!response.ok) throw new Error(`Run refresh failed: ${response.status}`);
      const previousStatus = report.value.status;
      const nextReport = await response.json();
      report.value = nextReport;
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
            icon: "/app-icon.svg",
            badge: "/app-icon.svg",
            tag: `runner-job-${nextReport.jobId}`,
            renotify: true,
            data: { url: `/runs/${nextReport.jobId}` },
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
    if (!data.jobId || String(data.jobId) === String(report.value.jobId)) void refreshRun();
  };
  const handleOutsideRestartMenu = (event) => {
    const menu = document.querySelector("[data-restart-menu]");
    if (menu?.open && !menu.contains(event.target)) menu.open = false;
  };

  onInit(() => {
    document.addEventListener("pointerdown", handleOutsideRestartMenu);
    void refreshRun();
    void loadAdminRole().catch((error) => console.error("Unable to load run editor access", error));
    if ("serviceWorker" in navigator) {
      navigator.serviceWorker.register("/service-worker.js").catch((error) => {
        console.error("Service worker registration failed", error);
      });
    }
    eventSource = new EventSource("/api/events");
    eventSource.addEventListener("jobs.changed", handleJobChange);
    refreshTimer = setInterval(() => {
      if (active.value) void refreshRun();
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
    isAdmin,
    previousRuns,
    manualRestartOpen,
    manualRestartLoading,
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
    timezone,
    formatDate,
    artifactUrl,
    downloadArtifact,
    stepLog,
    steps,
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
    formatDuration,
  };
}
