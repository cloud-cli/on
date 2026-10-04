/* global document, window, localStorage, navigator, URL, URLSearchParams, Headers, EventSource, Blob */

const icons = {
  runs: '<rect x="3" y="4" width="18" height="16" rx="3"/><path d="m10 8 5 4-5 4Z"/>',
  workflow:
    '<rect x="3" y="3" width="6" height="6" rx="1.5"/><rect x="15" y="15" width="6" height="6" rx="1.5"/><path d="M6 9v6a3 3 0 0 0 3 3h6M9 6h6a3 3 0 0 1 3 3v6"/>',
  server:
    '<rect x="3" y="3" width="18" height="7" rx="2"/><rect x="3" y="14" width="18" height="7" rx="2"/><path d="M7 6.5h.01M7 17.5h.01M11 6.5h6M11 17.5h6"/>',
  settings:
    '<path d="m9 3-1 3-3 1-2 3 2 2-1 3 3 2 3-1 2 2 3-1 1-3 3-1 2-3-2-2 1-3-3-2-3 1-2-2Z"/><circle cx="11.5" cy="10.5" r="3"/>',
  search: '<circle cx="10.5" cy="10.5" r="6.5"/><path d="m16 16 4 4"/>',
  plus: '<path d="M12 5v14M5 12h14"/>',
  arrow: '<path d="M5 12h14m-5-5 5 5-5 5"/>',
  back: '<path d="M19 12H5m5-5-5 5 5 5"/>',
  check: '<circle cx="12" cy="12" r="9"/><path d="m8 12 3 3 5-6"/>',
  failed: '<circle cx="12" cy="12" r="9"/><path d="m9 9 6 6m0-6-6 6"/>',
  running: '<path d="M20.4 8.8A9 9 0 1 1 15.2 3.6"/><path d="M20.4 3.6v5.2h-5.2"/>',
  pending: '<circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 2"/>',
  cancelled: '<circle cx="12" cy="12" r="9"/><path d="m6 6 12 12"/>',
  skipped: '<circle cx="12" cy="12" r="9"/><path d="M8 12h8"/>',
  branch:
    '<circle cx="6" cy="5" r="2"/><circle cx="6" cy="19" r="2"/><circle cx="18" cy="6" r="2"/><path d="M6 7v10m0-4h5a7 7 0 0 0 7-5"/>',
  clock: '<circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 2"/>',
  commit: '<circle cx="12" cy="12" r="4"/><path d="M3 12h5m8 0h5"/>',
  refresh: '<path d="M20 7v5h-5M4 17v-5h5"/><path d="M6.1 7a7 7 0 0 1 11.5-1L20 9M4 15l2.4 3A7 7 0 0 0 18 17"/>',
  terminal: '<path d="m5 6 6 6-6 6m9 0h5"/>',
  download: '<path d="M12 3v12m-4-4 4 4 4-4M4 16v4h16v-4"/>',
  copy: '<rect x="8" y="8" width="12" height="12" rx="2"/><path d="M16 8V4H4v12h4"/>',
  wrap: '<path d="M3 6h18M3 12h14a3 3 0 0 1 0 6h-5m3-3-3 3 3 3M3 18h4"/>',
  code: '<path d="m8 6-6 6 6 6m8-12 6 6-6 6M14 3l-4 18"/>',
  box: '<path d="m12 3 9 5v9l-9 5-9-5V8Zm0 9 9-4M3 8l9 4v10M7.5 5.5l9 5"/>',
  history: '<path d="M3 3v6h6M3.6 9a9 9 0 1 1-.2 6M12 7v5l3 2"/>',
  alert: '<path d="m12 3 10 18H2Z"/><path d="M12 9v5m0 3h.01"/>',
  lock: '<rect x="5" y="10" width="14" height="11" rx="2"/><path d="M8 10V6a4 4 0 0 1 8 0v4m-4 5v2"/>',
  stop: '<rect x="5" y="5" width="14" height="14" rx="2"/>',
};

const icon = (name) =>
  `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${icons[name] || icons.runs}</svg>`;
const escape = (value) =>
  String(value ?? "").replace(
    /[&<>"']/g,
    (character) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[character],
  );
const labels = {
  success: "Passed",
  failed: "Failed",
  running: "Running",
  pending: "Queued",
  cancelled: "Cancelled",
  skipped: "Skipped",
};
const statusIcon = (status) =>
  `<span class="status-icon ${escape(status)}">${icon(status === "success" ? "check" : status)}</span>`;
const iconForStatus = statusIcon;
const badge = (status) =>
  `<span class="status ${escape(status)}">${statusIcon(status)}${escape(labels[status] || status || "Unknown")}</span>`;

export function mountLivePreview() {
  const main = document.querySelector("#main");
  const dialog = document.querySelector("#dialog");
  const state = {
    jobs: [],
    workflows: [],
    workers: [],
    secrets: [],
    hasMore: false,
    loadingJobs: false,
    jobsLoaded: false,
    workflowsLoaded: false,
    workersLoaded: false,
    secretsLoaded: false,
    errors: {},
    search: "",
    status: "all",
    workflow: "all",
    worker: "all",
    workflowFilter: "all",
    page: 1,
    run: null,
    mutating: false,
    detailTab: "logs",
    step: 0,
    logSearch: "",
    wrap: false,
  };
  let apiClient;
  let events;
  let pollTimer;
  let previousRoute = "";
  let jobsLoadPromise;
  let refreshJobsAfterCurrentLoad = false;

  const route = () => {
    const [path, query = ""] = window.location.hash.slice(1).split("?");
    return { path: path || "/runs", query: new URLSearchParams(query) };
  };

  const client = async () => {
    apiClient ??= import("/api-client.mjs");
    return apiClient;
  };

  const apiJson = async (path, options = {}) => {
    const { apiFetch } = await client();
    const headers = new Headers(options.headers || {});
    headers.set("accept", "application/json");
    if (options.body && !headers.has("content-type")) {
      headers.set("content-type", "application/json");
    }
    const response = await apiFetch(path, { ...options, headers });
    if (!response.ok) {
      const payload = await response.json().catch(() => ({}));
      const error = new Error(payload.error || `Request failed (${response.status})`);
      error.status = response.status;
      throw error;
    }
    const badge = document.querySelector(".demo-label");
    if (badge) {
      badge.innerHTML = "<span></span>Live Flow data";
    }
    return response.status === 204 ? null : response.json();
  };

  const apiBlob = async (path) => {
    const { apiFetch } = await client();
    const response = await apiFetch(path);
    if (!response.ok) {
      const payload = await response.json().catch(() => ({}));
      throw new Error(payload.error || `Download failed (${response.status})`);
    }
    return response.blob();
  };

  const showToast = (message) => {
    const toast = document.querySelector("#toast");
    toast.textContent = message;
    toast.hidden = false;
    window.clearTimeout(showToast.timer);
    showToast.timer = window.setTimeout(() => {
      toast.hidden = true;
    }, 4500);
  };

  const dateValue = (value) => {
    if (!value) {
      return null;
    }
    const text = String(value);
    const date = new Date(text.includes("T") ? text : `${text.replace(" ", "T")}Z`);
    return Number.isNaN(date.getTime()) ? null : date;
  };

  const formatDate = (value) => {
    const date = dateValue(value);
    return date ? new Intl.DateTimeFormat(undefined, { dateStyle: "medium", timeStyle: "short" }).format(date) : "—";
  };

  const formatDuration = (milliseconds) => {
    const value = Number(milliseconds);
    if (!Number.isFinite(value) || value < 0) {
      return "—";
    }
    const seconds = Math.floor(value / 1000);
    return `${Math.floor(seconds / 60) ? `${Math.floor(seconds / 60)}m ` : ""}${seconds % 60}s`;
  };

  const workflowName = (workflowId) =>
    state.workflows.find((workflow) => workflow.id === workflowId)?.name || workflowId || "Unknown workflow";
  const pageHeading = (title, subtitle, action = "") =>
    `<div class="page-heading"><div><h1>${escape(title)}</h1><p class="subtitle">${escape(subtitle)}</p></div>${action}</div>`;
  const runWorkflowButton = () =>
    `<button class="button primary" data-action="new-run">${icon("plus")}Run workflow</button>`;
  const permissionMessage = (error, scope) =>
    [401, 403].includes(error?.status)
      ? `Your account needs the ${scope} permission to view this data.`
      : error?.message || "The Flow API could not be reached.";

  const setNavigation = (page, jobId = "") => {
    const currentJob = jobId ? state.jobs.find((job) => String(job.id) === String(jobId)) : null;
    const currentJobId = currentJob?.id ?? jobId;
    document.querySelector("#navigation").innerHTML = [
      ["runs", "Runs", "runs"],
      ["workflows", "Workflows", "workflow"],
      ["workers", "Workers", "server"],
      ["settings", "Settings", "settings"],
    ]
      .map(
        ([id, title, name]) =>
          `<a href="#/${id}" class="nav-item ${page === id ? "active" : ""}" ${page === id ? 'aria-current="page"' : ""}>${icon(name)}<span class="nav-label">${title}</span>${id === "runs" ? `<span class="nav-count">${state.jobs.filter((job) => ["running", "pending"].includes(job.status)).length}</span>` : ""}</a>`,
      )
      .join("");
    document.querySelector("#breadcrumbs").innerHTML =
      `<a href="#/runs">Apphor</a><span class="divider">/</span>${jobId ? `<a href="#/runs">Runs</a><span class="divider">/</span><strong class="mono">#${escape(currentJobId)}</strong>` : `<strong>${escape(page[0].toUpperCase() + page.slice(1))}</strong>`}`;
    document.title = `${jobId ? `Run #${currentJobId}` : page[0].toUpperCase() + page.slice(1)} · Flow`;
  };
  const setBreadcrumbs = (page, jobId = null) => setNavigation(page, jobId);

  const loadJobs = async ({ older = false } = {}) => {
    if (jobsLoadPromise) {
      if (!older) {
        refreshJobsAfterCurrentLoad = true;
      }
      await jobsLoadPromise;
      if (refreshJobsAfterCurrentLoad) {
        refreshJobsAfterCurrentLoad = false;
        await loadJobs();
      }
      return;
    }
    state.loadingJobs = true;
    const beforeId = older && state.jobs.length ? Math.min(...state.jobs.map((job) => Number(job.id))) : null;
    jobsLoadPromise = (async () => {
      try {
        const query = new URLSearchParams({ limit: older ? "50" : "100" });
        if (beforeId) {
          query.set("beforeId", String(beforeId));
        }
        if (state.workflow !== "all") {
          query.set("workflowId", state.workflow);
        }
        const data = await apiJson(`/api/jobs?${query}`);
        if (older) {
          const merged = new Map(state.jobs.map((job) => [String(job.id), job]));
          for (const job of data.jobs || []) {
            merged.set(String(job.id), job);
          }
          state.jobs = [...merged.values()].sort((a, b) => Number(b.id) - Number(a.id));
        } else {
          state.jobs = data.jobs || [];
        }
        state.hasMore = Boolean(data.hasMore);
        state.errors.jobs = null;
        state.jobsLoaded = true;
      } catch (error) {
        state.errors.jobs = error;
        state.jobsLoaded = true;
      } finally {
        state.loadingJobs = false;
      }
    })();
    try {
      await jobsLoadPromise;
    } finally {
      jobsLoadPromise = undefined;
      if (refreshJobsAfterCurrentLoad) {
        refreshJobsAfterCurrentLoad = false;
        await loadJobs();
      }
    }
  };

  const loadWorkflows = async ({ retry = false } = {}) => {
    if (state.workflowsLoaded && !retry) {
      return;
    }
    try {
      const data = await apiJson("/api/workflows");
      state.workflows = data.workflows || [];
      state.errors.workflows = null;
    } catch (error) {
      state.errors.workflows = error;
    } finally {
      state.workflowsLoaded = true;
    }
  };

  const loadWorkers = async ({ retry = false } = {}) => {
    if (state.workersLoaded && !retry) {
      return;
    }
    try {
      const data = await apiJson("/api/workers");
      state.workers = data.workers || [];
      state.errors.workers = null;
    } catch (error) {
      state.errors.workers = error;
    } finally {
      state.workersLoaded = true;
    }
  };

  const loadSecrets = async ({ retry = false } = {}) => {
    if (state.secretsLoaded && !retry) {
      return;
    }
    try {
      const data = await apiJson("/api/secrets");
      state.secrets = data.secrets || [];
      state.errors.secrets = null;
    } catch (error) {
      state.errors.secrets = error;
    } finally {
      state.secretsLoaded = true;
    }
  };

  const summary = () => {
    const complete = state.jobs.filter((job) => ["success", "failed"].includes(job.status));
    const passed = complete.filter((job) => job.status === "success").length;
    const elapsed = complete
      .map((job) => {
        const start = dateValue(job.createdAt)?.getTime();
        const end = dateValue(job.updatedAt)?.getTime();
        return start && end >= start ? end - start : null;
      })
      .filter((value) => value !== null)
      .sort((a, b) => a - b);
    const median = elapsed.length ? elapsed[Math.floor(elapsed.length / 2)] : null;
    return `<section class="overview" aria-label="Summary of ${state.jobs.length} recent Flow runs"><div class="metric"><div class="metric-label">${icon("runs")}Recent runs</div><div class="metric-bottom"><span class="metric-value">${state.jobs.length}</span><span class="metric-note">loaded from Flow</span></div></div><div class="metric"><div class="metric-label">${icon("check")}Pass rate</div><div class="metric-bottom"><span class="metric-value">${complete.length ? `${Math.round((passed / complete.length) * 100)}<small>%</small>` : "—"}</span><span class="metric-note">${passed} / ${complete.length} completed</span></div></div><div class="metric"><div class="metric-label">${icon("clock")}Median job lifecycle</div><div class="metric-bottom"><span class="metric-value">${median === null ? "—" : formatDuration(median)}</span></div><div class="metric-foot">Created to last update</div></div><div class="metric"><div class="metric-label">${icon("running")}In progress</div><div class="metric-bottom"><span class="metric-value">${state.jobs.filter((job) => job.status === "running").length}</span><span class="metric-note">${state.jobs.filter((job) => job.status === "pending").length} queued</span></div></div></section>`;
  };

  const filteredJobs = () =>
    state.jobs.filter((job) => {
      const text = [job.id, job.workflowId, workflowName(job.workflowId), job.status, job.workerId]
        .join(" ")
        .toLowerCase();
      return (
        text.includes(state.search.trim().toLowerCase()) &&
        (state.status === "all" ||
          (state.status === "running" ? ["pending", "running"].includes(job.status) : job.status === state.status)) &&
        (state.workflow === "all" || job.workflowId === state.workflow) &&
        (state.worker === "all" || (state.worker === "queued" ? !job.workerId : job.workerId === state.worker))
      );
    });

  const renderRunsTable = () => {
    const filtered = filteredJobs();
    const pages = Math.max(1, Math.ceil(filtered.length / 8));
    state.page = Math.min(state.page, pages);
    const rows = filtered.slice((state.page - 1) * 8, state.page * 8);
    const target = document.querySelector("#run-results");
    if (!target) {
      return;
    }
    target.innerHTML = `<div class="filter-tabs" role="group" aria-label="Filter by run status">${[
      ["all", "All runs"],
      ["running", "In progress"],
      ["failed", "Failed"],
      ["success", "Passed"],
    ]
      .map(
        ([value, label]) =>
          `<button class="filter-tab ${state.status === value ? "active" : ""}" data-action="status-filter" data-value="${value}" aria-pressed="${state.status === value}">${label}<span class="count">${state.jobs.filter((job) => value === "all" || (value === "running" ? ["pending", "running"].includes(job.status) : job.status === value)).length}</span></button>`,
      )
      .join("")}</div>
      ${rows.length ? `<table class="run-table"><caption class="sr-only">Live Flow runs, newest first</caption><thead><tr><th scope="col">Workflow / run</th><th scope="col">Status</th><th scope="col">Worker</th><th scope="col">Updated</th><th scope="col">Created</th></tr></thead><tbody>${rows.map((job) => `<tr><td><a class="run-link" href="#/runs/${encodeURIComponent(job.id)}" aria-label="Run ${escape(job.id)}: ${escape(workflowName(job.workflowId))}, ${escape(labels[job.status] || job.status)}">${statusIcon(job.status)}<span class="run-copy"><span class="run-title">${escape(workflowName(job.workflowId))}</span><span class="run-subtitle"><span class="mono">#${escape(job.id)}</span><span class="separator">·</span><span class="mono">${escape(job.workflowId)}</span></span></span></a></td><td>${badge(job.status)}</td><td><span class="branch">${icon("server")}${escape(job.workerId || "Queued")}</span></td><td>${escape(formatDate(job.updatedAt))}</td><td>${escape(formatDate(job.createdAt))}</td></tr>`).join("")}</tbody></table>` : `<div class="empty-state">${icon("search")}<h3>${state.errors.jobs ? "Runs unavailable" : "No runs found"}</h3><p>${escape(state.errors.jobs?.message || "Try a different search or filter.")}</p>${state.errors.jobs ? '<button class="button" data-action="retry-runs">Retry</button>' : '<button class="button" data-action="clear-filters">Clear filters</button>'}</div>`}
      <div class="table-footer"><span role="status">${filtered.length ? `${(state.page - 1) * 8 + 1}–${Math.min(state.page * 8, filtered.length)} of ${filtered.length} runs` : "0 runs"}</span><div class="pagination"><button class="button" data-action="prev-page" ${state.page === 1 ? "disabled" : ""}>${icon("back")}Previous</button><span>${state.page} / ${pages}</span><button class="button" data-action="next-page" ${state.page === pages && !state.hasMore ? "disabled" : ""}>Next${icon("arrow")}</button></div></div>${state.hasMore ? '<div class="table-hint">Older Flow runs are available.</div>' : ""}`;
  };

  const renderRuns = () => {
    setBreadcrumbs("runs");
    main.innerHTML = `${pageHeading("Runs", "Runs", runWorkflowButton())}${state.loadingJobs && !state.jobs.length ? '<div class="empty-state"><p>Loading runs…</p></div>' : ''}<section aria-labelledby="recent-runs"><div class="section-heading"><h2 id="recent-runs">Recent runs <span class="count">${state.jobs.length}</span></h2></div><div class="filters"><label class="search-box">${icon("search")}<span class="sr-only">Search runs</span><input id="run-search" type="search" value="${escape(state.search)}" placeholder="Search runs, workflows, or workers…" autocomplete="off"/><kbd aria-hidden="true">/</kbd></label><select id="workflow-filter" class="select-filter" aria-label="Filter by workflow"><option value="all">All workflows</option>${state.workflows.map((workflow) => `<option value="${escape(workflow.id)}" ${state.workflow === workflow.id ? "selected" : ""}>${escape(workflow.name)}</option>`).join("")}</select><select id="worker-filter" class="select-filter" aria-label="Filter by worker"><option value="all">All workers</option><option value="queued" ${state.worker === "queued" ? "selected" : ""}>Queued</option>${[...new Set(state.jobs.map((job) => job.workerId).filter(Boolean))].map((worker) => `<option value="${escape(worker)}" ${state.worker === worker ? "selected" : ""}>${escape(worker)}</option>`).join("")}</select></div><div id="run-results"></div></section>`;
    renderRunsTable();
  };

  const renderRunDetails = (run) => {
    setBreadcrumbs("runs", run.jobId);
    const inputs = run.inputs || {};
    const failedStep = (run.steps || []).find((step) => step.status === "failed");
    main.innerHTML = `<a href="#/runs" class="back-link">${icon("back")}All runs</a>
      <div class="page-heading run-heading"><div><h1>${iconForStatus(run.status)}${escape(run.workflowName || workflowName(run.workflowId))}</h1><p class="subtitle"><span class="mono">#${escape(run.jobId)}</span><span>·</span><span>${escape(inputs.full_name || inputs.repo || run.workflowId || "Workflow run")}</span></p></div>
      <div class="heading-actions">${run.canViewLogs ? `<button class="button" data-action="download-logs">${icon("download")}Download logs</button>` : ""}<button class="button ${["running", "pending"].includes(run.status) ? "danger" : "primary"}" data-action="${["running", "pending"].includes(run.status) ? "cancel" : "rerun"}" ${state.mutating ? "disabled" : ""}>${icon(["running", "pending"].includes(run.status) ? "stop" : "refresh")}${["running", "pending"].includes(run.status) ? "Cancel run" : "Re-run workflow"}</button></div></div>
      ${failedStep ? `<div class="failure-banner">${icon("alert")}<div><strong>${escape(failedStep.name || "Step")} failed${failedStep.exitCode !== undefined ? ` with exit code ${escape(failedStep.exitCode)}` : ""}</strong><p>${escape(failedStep.error || "See the failed step output.")}</p></div><button class="text-button" data-action="jump-error">Jump to error ${icon("arrow")}</button></div>` : ""}
      <section class="detail-meta" aria-label="Run metadata"><div><span class="meta-label">STATUS</span><span class="meta-value">${badge(run.status)}</span></div><div><span class="meta-label">BRANCH</span><span class="meta-value">${icon("branch")}${escape(inputs.branch || inputs.ref?.replace(/^refs\/heads\//, "") || "—")}</span></div><div><span class="meta-label">COMMIT</span><span class="meta-value mono">${icon("commit")}${escape((inputs.commit_sha || inputs.commit || "—").slice(0, 8))}</span></div><div><span class="meta-label">DURATION</span><span class="meta-value">${icon("clock")}${formatDuration(run.durationMs)}</span></div><div><span class="meta-label">WORKER</span><span class="meta-value">${icon("server")}${escape(run.workerId || "Queued")}</span></div></section>
      <div class="detail-tabs" role="group" aria-label="Run detail views">${[
        ["logs", "Logs & steps", "terminal"],
        ["inputs", "Inputs", "code"],
        ["artifacts", "Artifacts", "box"],
        ["history", "History", "history"],
      ]
        .map(
          ([value, title, symbol]) =>
            `<button data-action="detail-tab" data-value="${value}" class="${state.detailTab === value ? "active" : ""}" aria-pressed="${state.detailTab === value}">${icon(symbol)}${title}</button>`,
        )
        .join("")}</div>
      <div id="detail-content"></div>`;
    void renderRunTab(run);
  };

  const liveRunPage = async (id) => {
    main.innerHTML = `<div class="empty-state">${icon("clock")}<p>Loading run #${escape(id)}…</p></div>`;
    try {
      const run = await apiJson(`/api/runs/${encodeURIComponent(id)}`);
      state.errors.run = null;
      state.run = run;
      const importantStep = run.steps?.findIndex((step) => ["failed", "running"].includes(step.status)) ?? -1;
      if (importantStep >= 0) {
        state.step = importantStep;
      }
      renderRunDetails(run);
    } catch (error) {
      state.errors.run = error;
      main.innerHTML = `<div class="empty-state">${icon("alert")}<h1>Run unavailable</h1><p>${escape(error.message)}</p><a class="button" href="#/runs">Back to runs</a></div>`;
    }
  };

  const renderRunTab = async (run) => {
    const content = document.querySelector("#detail-content");
    if (!content) {
      return;
    }
    if (state.detailTab === "inputs") {
      let source = run.workflowSourceYaml || "";
      if (!source && run.workflowId) {
        try {
          const workflow = await apiJson(
            `/api/workflows/${encodeURIComponent(run.workflowId)}?revision=${encodeURIComponent(run.workflowRevision || "")}`,
          );
          source = workflow.sourceYaml || "";
        } catch {
          /* Workflow source has separate permission checks. */
        }
      }
      content.innerHTML = `<section class="source-view"><h3>Trigger inputs</h3><pre>${escape(JSON.stringify(run.inputs || {}, null, 2))}</pre></section>${source ? `<section class="source-view" style="margin-top:16px"><h3>Workflow source · revision ${escape(run.workflowRevision || "—")}</h3><pre>${escape(source)}</pre></section>` : '<p class="settings-note" style="margin-top:14px">Workflow source is unavailable for this run.</p>'}`;
      return;
    }
    if (state.detailTab === "artifacts") {
      const artifacts = run.artifacts || [];
      content.innerHTML = artifacts.length
        ? `<section class="settings-section"><h2>Run artifacts <span class="count">${artifacts.length}</span></h2>${artifacts.map((path, index) => `<div class="setting-row"><div><strong class="mono">${escape(path.split("/").pop() || path)}</strong><p>${escape(path)}</p></div><button class="button" data-action="download-artifact" data-value="${index}">${icon("download")}Download</button></div>`).join("")}</section>`
        : '<div class="empty-state"><h3>No artifacts</h3><p>This run did not publish any artifacts.</p></div>';
      return;
    }
    if (state.detailTab === "history") {
      const history = await loadRunHistory(run);
      content.innerHTML =
        history.length > 1
          ? `<section class="settings-section"><h2>Execution history</h2>${history.map((entry) => `<div class="setting-row"><div><strong><a href="#/runs/${encodeURIComponent(entry.jobId)}">Run #${escape(entry.jobId)}</a></strong><p>${escape(entry.workflowName || entry.workflowId || "Workflow")} · ${formatDate(entry.startedAt)}</p></div>${badge(entry.status)}</div>`).join("")}</section>`
          : '<div class="empty-state"><h3>No previous attempts</h3><p>This run has no parent run linked to it.</p></div>';
      return;
    }
    const steps = run.steps || [];
    if (!steps.length) {
      content.innerHTML =
        '<div class="empty-state"><h3>No execution steps yet</h3><p>Step details will appear when Flow records them.</p></div>';
      return;
    }
    state.step = Math.max(0, Math.min(state.step, steps.length - 1));
    const selected = steps[state.step];
    const stepButtons = steps
      .map(
        (step, index) =>
          `<button class="step-button ${state.step === index ? "active" : ""}" data-action="step" data-value="${index}" aria-pressed="${state.step === index}" aria-label="${escape(step.name)}, ${escape(labels[step.status] || step.status)}">${iconForStatus(step.status)}<span>${escape(step.name)}</span><span class="mono">${formatDuration(step.durationMs)}</span></button>`,
      )
      .join("");
    if (!run.canViewLogs) {
      content.innerHTML = `<section class="execution" aria-label="Execution steps and logs"><aside class="steps-panel" aria-label="Execution steps"><div class="steps-heading"><span>Execution steps</span><span class="mono">${steps.filter((step) => step.status === "success").length} / ${steps.length}</span></div>${stepButtons}</aside><div class="log-panel"><div class="empty-state">${icon("lock")}<h3>Logs require permission</h3><p>Your account needs <span class="mono">logs:read</span> to view step output.</p></div></div></section>`;
      return;
    }
    content.innerHTML = `<section class="execution" aria-label="Execution steps and logs"><aside class="steps-panel" aria-label="Execution steps"><div class="steps-heading"><span>Execution steps</span><span class="mono">${steps.filter((step) => step.status === "success").length} / ${steps.length}</span></div>${steps.map((step, index) => `<button class="step-button ${state.step === index ? "active" : ""}" data-action="step" data-value="${index}" aria-pressed="${state.step === index}" aria-label="${escape(step.name)}, ${escape(labels[step.status] || step.status)}">${iconForStatus(step.status)}<span>${escape(step.name)}</span><span class="mono">${formatDuration(step.durationMs)}</span></button>`).join("")}</aside><div class="log-panel"><div class="log-heading"><h3>${escape(selected.name)}<small>${selected.exitCode !== undefined ? `exit code ${escape(selected.exitCode)}` : escape(labels[selected.status] || selected.status)}</small></h3><div class="log-actions"><button class="icon-button" data-action="wrap" aria-label="Wrap log lines" aria-pressed="${state.wrap}">${icon("wrap")}</button><button class="icon-button" data-action="copy-log" aria-label="Copy step log">${icon("copy")}</button></div></div><label class="log-search">${icon("search")}<span class="sr-only">Search step log</span><input id="log-search" type="search" placeholder="Find in this step…" value="${escape(state.logSearch)}"/><span id="log-matches"></span></label><div class="log-lines ${state.wrap ? "wrap" : ""}" id="log-lines" tabindex="0" aria-label="Step log output"></div><div class="log-bottom"><span>${selected.status === "failed" ? "Step failed" : selected.status === "running" ? "Step is running" : "End of step output"}</span><span class="mono">UTF-8</span></div></div></section>`;
    renderLog(selected.logContent || "");
  };

  const loadRunHistory = async (run) => {
    const entries = [run];
    const visited = new Set([String(run.jobId)]);
    let parent = run.parentId;
    while (parent && !visited.has(String(parent)) && entries.length < 25) {
      visited.add(String(parent));
      try {
        const entry = await apiJson(`/api/runs/${encodeURIComponent(parent)}`);
        entries.push(entry);
        parent = entry.parentId;
      } catch {
        break;
      }
    }
    return entries;
  };

  const renderLog = (text) => {
    const log = document.querySelector("#log-lines");
    if (!log) {
      return;
    }
    const query = state.logSearch.toLowerCase();
    let matches = 0;
    log.innerHTML = String(text)
      .split("\n")
      .map((line, index) => {
        let content = escape(line) || " ";
        const start = query ? line.toLowerCase().indexOf(query) : -1;
        if (start >= 0) {
          matches++;
          content = `${escape(line.slice(0, start))}<mark>${escape(line.slice(start, start + query.length))}</mark>${escape(line.slice(start + query.length))}`;
        }
        const type = /\b(error|failed|fatal)\b/i.test(line)
          ? "error"
          : /\b(success|passed|done)\b/i.test(line)
            ? "pass"
            : "";
        return `<div class="log-line ${type}"><span class="line-number">${index + 1}</span><span class="line-text">${content}</span></div>`;
      })
      .join("");
    const result = document.querySelector("#log-matches");
    if (result) {
      result.textContent = query ? `${matches} matching lines` : "";
    }
  };
  const renderLiveLog = renderLog;

  const downloadBlob = (blob, filename) => {
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement("a");
    anchor.href = url;
    anchor.download = filename;
    anchor.click();
    window.setTimeout(() => URL.revokeObjectURL(url), 1000);
  };

  const liveWorkflowsPage = async () => {
    if (!state.workflowsLoaded) {
      await loadWorkflows();
    }
    setBreadcrumbs("workflows");
    // Group workflows by status for tabbed display
    const publishedWorkflows = state.workflows.filter((w) => w.status === "published" || (w.enabled && !w.status));
    const draftWorkflows = state.workflows.filter((w) => !w.status && !w.enabled);
    const otherWorkflows = state.workflows.filter((w) => w.status && w.status !== "published" && (w.enabled || !w.enabled));
    
    const tabs = [
      { id: "published", label: "Published", filter: (w) => w.status === "published" },
      { id: "enabled", label: "Enabled", filter: (w) => w.enabled && (!w.status || !["published"].includes(w.status)) },
      { id: "draft", label: "Drafts", filter: (w) => !w.enabled && !w.status },
      { id: "other", label: "Other", filter: (w) => w.status && w.status !== "published" && (!w.enabled || w.status === "archived") },
    ];
    
    const tabButtons = tabs.map((tab) => `
      <button class="status-tab ${state.workflowFilter === tab.id ? "active" : ""}" data-action="workflow-status-tab" data-value="${tab.id}">${tab.label}${tab.label === state.workflowFilter ? ' <span class="tag">✓</span>' : ''}</button>
    `).join("");
    
    const renderWorkflowList = (workflows) => {
      if (!workflows.length) return '<div class="empty-state"><h3>No workflows</h3><p>Flow has no workflow definitions to show.</p></div>';
      return `<div class="workflow-list">${workflows.map((workflow, index) => `
        <div class="workflow-item">
          <div class="workflow-header">
            <span class="workflow-icon">${icon("workflow")}</span>
            <span class="workflow-name">${escape(workflow.name || workflow.id)}</span>
            <span class="workflow-status ${workflow.status === "published" ? "success" : workflow.enabled ? "enabled" : "disabled"}">${escape(workflow.status || (workflow.enabled ? "Enabled" : "Disabled"))}</span>
          </div>
          <div class="workflow-meta">
            <span>Revision ${escape(workflow.revision || "—")}</span>
            <span class="workflow-id mono">${escape(workflow.id)}</span>
          </div>
          <div class="workflow-actions">
            <a class="text-button" href="#/runs?workflow=${encodeURIComponent(workflow.id)}">View runs ${icon("arrow")}</a>
            <a class="button" href="/settings/workflows/${encodeURIComponent(workflow.id)}" target="_top">Edit ${icon("arrow")}</a>
            <button class="button" data-action="workflow-source" data-value="${index}">${icon("code")}Source</button>
            <template if="workflow.revision > 1"><button class="button small" data-action="workflow-revision" data-value="${index}" data-dir="-1">Prev rev</button><button class="button small" data-action="workflow-revision" data-value="${index}" data-dir="1">Next rev</button></template>
            <template if="!workflow.published"><button class="button small success" data-action="workflow-publish" data-value="${index}">Publish ${icon("rocket")}</button></template>
          </div>
        </div>
      `).join("")}</div>`;
    };
    
    const filteredWorkflows = tabs.map((tab) => state.workflows.filter(tab.filter)).filter((w) => w.length > 0);
    
    const hasMultipleTabs = tabs.length > 1 && filteredWorkflows.some((w) => w.length > 0);
    
    const tabSection = hasMultipleTabs ? `
      <div class="status-tabs">${tabButtons}</div>
      <div class="workflow-content">${filteredWorkflows.map((w, i) => renderWorkflowList(w).replace('<div class="workflow-list">', `<div class="workflow-list workflow-list-${i}">`).replace("</div>", `</div><!-- workflow-list-${i} -->`)).join("")}</div>` : '';
    
    const emptyState = state.workflows.length ? '' : '<div class="empty-state"><h3>No workflows</h3><p>Flow has no workflow definitions to show.</p></div>';
    
    main.innerHTML = `${pageHeading("Workflows", "Workflow definitions from Flow.", runWorkflowButton())}${state.errors.workflows ? `<div class="empty-state">${icon("lock")}<h3>Workflows unavailable</h3><p>${escape(permissionMessage(state.errors.workflows, "workflows:read"))}</p><button class="button" data-action="retry-workflows">Retry</button></div>` : tabSection || emptyState}`;
  };

  const liveWorkersPage = async () => {
    if (!state.workersLoaded) {
      await loadWorkers();
    }
    setBreadcrumbs("workers");
    main.innerHTML = `${pageHeading("Workers", "Live runner presence from Flow.")}${state.errors.workers ? `<div class="empty-state">${icon("lock")}<h3>Worker status unavailable</h3><p>${escape(permissionMessage(state.errors.workers, "workers:read"))}</p><button class="button" data-action="retry-workers">Retry</button></div>` : `<div class="cards">${state.workers.map((worker) => `<article class="worker-card"><div class="card-heading">${icon("server")}<h2>${escape(worker.workerId || "Unknown worker")}</h2><span class="status ${worker.online ? "success" : "cancelled"}">${worker.online ? "Online" : "Offline"}</span></div><div class="card-details">${(Array.isArray(worker.tags) ? worker.tags : []).map((tag) => `<span class="tag mono">${escape(tag)}</span>`).join("") || '<span class="settings-note">No labels</span>'}</div><div class="worker-stats"><div><span class="meta-label">Active jobs</span><strong>${escape(worker.activeJobs ?? 0)}</strong></div><div><span class="meta-label">Concurrency</span><strong>${escape(worker.concurrency ?? "—")}</strong></div></div><div class="card-footer"><span class="settings-note">${worker.version ? `Runner ${escape(worker.version)}` : "Runner version unavailable"}</span><span class="settings-note">Seen ${escape(formatDate(worker.lastSeen))}</span></div></article>`).join("") || '<div class="empty-state"><h3>No workers reported</h3><p>Flow has no worker-presence records.</p></div>'}</div>`}`;
  };

  const liveSettingsPage = async () => {
    if (!state.secretsLoaded) {
      await loadSecrets();
    }
    setBreadcrumbs("settings");
    main.innerHTML = `${pageHeading("Settings", "Preferences and secret names from Flow.")}<section class="settings-section"><h2>Preferences</h2><label class="setting-row"><span><strong>Compact run list</strong><span class="settings-note">Fit more activity on your screen.</span></span><input type="checkbox" id="compact-setting" ${localStorage.getItem("flow-concept-compact") === "true" ? "checked" : ""}/></label><label class="setting-row"><span><strong>Wrap log lines</strong><span class="settings-note">Keep long output within the log viewer.</span></span><input type="checkbox" id="wrap-setting" ${state.wrap ? "checked" : ""}/></label></section><section class="settings-section"><h2>${icon("lock")} Secret names</h2><p class="settings-note">Values are never requested or displayed in this preview.</p>${state.errors.secrets ? `<p class="settings-note">${escape(permissionMessage(state.errors.secrets, "secrets:read"))}</p><button class="button" data-action="retry-secrets">Retry</button>` : state.secrets.map((name) => `<div class="setting-row"><strong class="mono">${escape(name)}</strong><span class="secret-value" aria-label="Secret value hidden">••••••••••••</span><button class="button tiny danger" data-action="remove-secret" data-value="${name}">Remove</button></div>`).join("") || '<p class="settings-note">No secret names are configured.</p>'}<template if="!state.errors.secrets && state.secrets.length < 5"><div class="setting-row"><button class="button tiny" data-action="add-secret">Add secret</button></div></template></section><section class="settings-section"><h2>Workflow editing</h2><p class="settings-note">Create and edit workflow definitions.</p><form id="new-workflow-form"><label class="form-field"><span>Workflow name</span><input id="new-workflow-name" type="text" placeholder="e.g. build-docker-image" required/></label><label class="form-field"><span>Workflow ID</span><input id="new-workflow-id" type="text" placeholder="derived-from-name" required/></label><label class="form-field"><span>Enabled</span><input type="checkbox" id="new-workflow-enabled" checked/></label><div class="form-field"><span>YAML source</span><textarea id="new-workflow-source" rows="8" placeholder="name: build-docker-image\nruns-on: [main-server, docker]\n\nsteps:\n  - name: Checkout repository\n    run: git checkout \"$COMMIT\"\n  - name: Install dependencies\n    run: pnpm install --frozen-lockfile\n  - name: Run tests\n    run: pnpm test\n  - name: Build and push\n    run: pnpm publish"></textarea></label></div><div class="form-footer"><button type="button" class="button" data-action="validate-workflow">Validate workflow</button><button type="button" class="button" data-action="run-now">Run now</button><button type="submit" class="button primary">${icon("plus")}Create workflow</button><button type="button" class="button" data-action="close-dialog">Cancel</button></div></form><a class="button secondary" href="/settings/workflows" target="_top">Open full workflow settings ${icon("arrow")}</a></section>`;
  };

  const showNotFound = () => {
    setBreadcrumbs("runs");
    main.innerHTML = `<div class="empty-state"><h1>404 — Page not found</h1><p>This preview route does not exist.</p><a class="button" href="#/runs">Go to runs</a></div>`;
  };

  const openDialog = (title, content) => {
    dialog.innerHTML = `<div class="dialog-heading"><h2 id="dialog-title">${escape(title)}</h2><button class="icon-button" data-action="close-dialog" aria-label="Close dialog">${icon("close")}</button></div>${content}`;
    if (!dialog.open) {
      dialog.showModal();
    }
  };

  const openDispatchDialog = async () => {
    if (!state.workflowsLoaded) {
      await loadWorkflows();
    }
    if (state.errors.workflows) {
      showToast(permissionMessage(state.errors.workflows, "workflows:read"));
      return;
    }
    openDialog(
      "Run a workflow",
      `<p class="dialog-description">This will enqueue a real Flow job.</p><label class="form-field"><span>Workflow</span><select id="dispatch-workflow">${state.workflows.map((workflow) => `<option value="${escape(workflow.id)}" ${workflow.enabled === false ? "disabled" : ""}>${escape(workflow.name || workflow.id)}${workflow.enabled === false ? " (disabled)" : ""}</option>`).join("")}</select></label><label class="form-field"><span>Inputs (JSON object)</span><textarea id="dispatch-inputs" rows="6">{}</textarea></label><p class="dialog-note">Running a workflow requires write permission and creates real job(s).</p><div class="dialog-footer"><button class="button" data-action="close-dialog">Cancel</button><button class="button primary" data-action="dispatch-confirm">${icon("runs")}Review and run</button></div>`,
    );
  };

  const dispatchWorkflow = async () => {
    if (state.mutating) {
      return;
    }
    const workflowId = document.querySelector("#dispatch-workflow")?.value;
    if (!workflowId) {
      showToast("Select a workflow first.");
      return;
    }
    let inputs;
    try {
      inputs = JSON.parse(document.querySelector("#dispatch-inputs")?.value || "{}");
      if (!inputs || typeof inputs !== "object" || Array.isArray(inputs)) {
        throw new Error("Inputs must be a JSON object.");
      }
    } catch (error) {
      showToast(error.message);
      return;
    }
    const workflow = state.workflows.find((item) => item.id === workflowId);
    if (workflow?.enabled === false) {
      showToast("This workflow is disabled and cannot be run.");
      return;
    }
    state.mutating = true;
    const dispatchButton = document.querySelector('[data-action="dispatch-confirm"]');
    if (dispatchButton) {
      dispatchButton.disabled = true;
    }
    if (!window.confirm(`Run ${workflow?.name || workflowId} now? This creates real job(s).`)) {
      state.mutating = false;
      if (dispatchButton) {
        dispatchButton.disabled = false;
      }
      return;
    }
    try {
      const result = await apiJson(`/api/workflows/${encodeURIComponent(workflowId)}/run`, {
        method: "POST",
        body: JSON.stringify({ inputs }),
      });
      dialog.close();
      state.jobs = [];
      state.jobsLoaded = false;
      await loadJobs();
      showToast(`Queued ${result.jobs?.length || 0} real job(s).`);
      if (result.jobs?.length) {
        window.location.hash = `/runs/${result.jobs[0]}`;
      }
    } catch (error) {
      showToast(`Could not run workflow: ${error.message}`);
    } finally {
      state.mutating = false;
      if (dispatchButton) {
        dispatchButton.disabled = false;
      }
    }
  };

  const render = async () => {
    const { path, query } = route();
    const [section, id] = path.split("/").slice(1);
    const page = section || "runs";
    const changed = previousRoute !== window.location.hash;
    if (changed) {
      state.step = 0;
      state.detailTab = "logs";
      state.logSearch = "";
      if (section !== "runs" || !id) {
        state.run = null;
      }
    }
    previousRoute = window.location.hash;
    setNavigation(page === "runs" ? "runs" : ["workflows", "workers", "settings"].includes(page) ? page : "runs", id);
    if (path === "/runs" || path === "") {
      const workflowFilter = query.get("workflow") || "all";
      const searchFilter = query.get("search") || "";
      if (workflowFilter !== state.workflow || searchFilter !== state.search) {
        state.jobs = [];
        state.jobsLoaded = false;
        state.hasMore = false;
      }
      state.workflow = workflowFilter;
      state.search = searchFilter;
      const statusFilter = query.get("status");
      if (["all", "running", "failed", "success"].includes(statusFilter)) {
        state.status = statusFilter;
      }
      if (!state.jobsLoaded) {
        await loadJobs();
      }
      if (!state.workflowsLoaded) {
        await loadWorkflows();
      }
      renderRuns();
      if (changed) {
        window.scrollTo(0, 0);
      }
      return;
    }
    if (section === "runs" && id) {
      await liveRunPage(id);
      return;
    }
    if (path === "/workflows") {
      await liveWorkflowsPage();
      return;
    }
    if (path === "/workers") {
      await liveWorkersPage();
      return;
    }
    if (path === "/settings") {
      await liveSettingsPage();
      return;
    }
    showNotFound();
  };

  const action = async (event) => {
    const button = event.target.closest("[data-action]");
    if (!button) {
      return false;
    }
    const { action: name, value } = button.dataset;
    if (name === "new-run") {
      await openDispatchDialog();
      return true;
    }
    if (name === "close-dialog") {
      dialog.close();
      return true;
    }
    if (name === "dispatch-confirm") {
      await dispatchWorkflow();
      return true;
    }
    if (name === "retry-runs") {
      state.jobsLoaded = false;
      state.errors.jobs = null;
      await loadJobs();
      renderRuns();
      return true;
    }
    if (name === "retry-workflows") {
      state.workflowsLoaded = false;
      state.errors.workflows = null;
      await liveWorkflowsPage();
      return true;
    }
    if (name === "workflow-status-tab") {
      state.workflowFilter = value;
      render();
      return true;
    }
    if (name === "retry-workers") {
      state.workersLoaded = false;
      state.errors.workers = null;
      await liveWorkersPage();
      return true;
    }
    if (name === "retry-secrets") {
      state.secretsLoaded = false;
      state.errors.secrets = null;
      await liveSettingsPage();
      return true;
    }
    if (name === "add-secret") {
      const name = prompt("Enter secret name (uppercase letters, numbers, underscores):");
      if (!name) return true;
      if (!/^[A-Z][A-Z0-9_]*$/.test(name)) {
        showToast("Secret name must start with a letter and contain only letters, numbers, and underscores.");
        return true;
      }
      try {
        await apiJson(`/api/secrets/${name}`, {
          method: "PUT",
          body: JSON.stringify({ value: "", encoding: "utf8" }),
        });
        showToast(`Secret ${name} added.`);
        state.secretsLoaded = false;
        void loadWorkflows(); // This will also reload secrets
        render();
      } catch (error) {
        showToast(`Failed to add secret: ${error.message}`);
      }
      return true;
    }
    if (name === "remove-secret") {
      const name = value;
      if (!confirm(`Delete secret ${name}?`)) return true;
      try {
        await apiJson(`/api/secrets/${name}`, { method: "DELETE" });
        showToast(`Secret ${name} removed.`);
        state.secretsLoaded = false;
        void loadWorkflows(); // This will also reload secrets
        render();
      } catch (error) {
        showToast(`Failed to remove secret: ${error.message}`);
      }
      return true;
    }
    if (name === "status-filter") {
      state.status = value;
      state.page = 1;
      renderRunsTable();
      button.focus({ preventScroll: true });
      return true;
    }
    if (name === "clear-filters") {
      state.search = "";
      state.status = "all";
      state.workflow = "all";
      state.worker = "all";
      state.page = 1;
      renderRuns();
      document.querySelector("#run-search")?.focus();
      return true;
    }
    if (name === "prev-page" || name === "next-page") {
      const pages = Math.max(1, Math.ceil(filteredJobs().length / 8));
      if (name === "next-page" && state.page === pages && state.hasMore) {
        await loadJobs({ older: true });
      }
      state.page = Math.max(1, state.page + (name === "next-page" ? 1 : -1));
      renderRunsTable();
      return true;
    }
    if (name === "detail-tab" && state.run) {
      state.detailTab = value;
      await renderRunTab(state.run);
      return true;
    }
    if (name === "step" && state.run) {
      state.step = Number(value);
      await renderRunTab(state.run);
      return true;
    }
    if (name === "jump-error" && state.run) {
      const failed = state.run.steps?.findIndex((step) => step.status === "failed") ?? -1;
      if (failed >= 0) {
        state.step = failed;
        await renderRunTab(state.run);
      }
      return true;
    }
    if (name === "wrap") {
      state.wrap = !state.wrap;
      document.querySelector("#log-lines")?.classList.toggle("wrap", state.wrap);
      button.setAttribute("aria-pressed", String(state.wrap));
      return true;
    }
    if (name === "copy-log" && state.run) {
      try {
        await navigator.clipboard.writeText(state.run.steps?.[state.step]?.logContent || "");
        showToast("Step log copied.");
      } catch {
        showToast("Clipboard unavailable.");
      }
      return true;
    }
    if (name === "download-logs" && state.run) {
      const text = (state.run.steps || []).map((step) => `=== ${step.name} ===\n${step.logContent || ""}`).join("\n\n");
      downloadBlob(new Blob([text], { type: "text/plain;charset=utf-8" }), `flow-run-${state.run.jobId}.log`);
      return true;
    }
    if (name === "download-artifact" && state.run) {
      const artifact = state.run.artifacts?.[Number(value)];
      if (!artifact) {
        return true;
      }
      const encoded = String(artifact).split("/").map(encodeURIComponent).join("/");
      try {
        const blob = await apiBlob(`/api/runs/${encodeURIComponent(state.run.jobId)}/artifacts/${encoded}`);
        downloadBlob(blob, String(artifact).split("/").pop() || "artifact");
      } catch (error) {
        showToast(`Download failed: ${error.message}`);
      }
      return true;
    }
    if (name === "workflow-source") {
      const workflow = state.workflows[Number(value)];
      if (workflow) {
        openDialog(
          workflow.name || workflow.id,
          `<p class="dialog-description">Revision ${escape(workflow.revision || "—")} · ${escape(workflow.status || "")}</p><div class="source-view"><pre>${escape(workflow.sourceYaml || "Workflow source unavailable.")}</pre></div><div class="dialog-footer"><button class="button" data-action="close-dialog">Close</button></div>`,
        );
      }
      return true;
    }
    if (name === "validate-workflow") {
      const source = document.getElementById("new-workflow-source")?.value.trim();
      if (!source) {
        showToast("Please enter workflow source YAML first.");
        return true;
      }
      apiJson(`/api/workflows/validate`, {
        method: "POST",
        body: JSON.stringify({ sourceYaml: source }),
      })
        .then((result) => {
          const status = result.valid ? "passed" : "failed";
          showToast(`Validation ${status}: ${result.error || ''}`);
        })
        .catch((error) => {
          showToast(`Validation failed: ${error.message}`);
        });
      return true;
    }
    if (name === "run-now") {
      const id = document.getElementById("new-workflow-id")?.value.trim();
      const source = document.getElementById("new-workflow-source")?.value.trim();
      if (!id) {
        showToast("Please enter a workflow ID first.");
        return true;
      }
      if (!source) {
        showToast("Please enter workflow source YAML first.");
        return true;
      }
      if (!/^[a-z0-9-]+$/.test(id)) {
        showToast("Workflow ID can only contain lowercase letters, numbers, and hyphens.");
        return true;
      }
      apiJson(`/api/workflows/${id}/run`, {
        method: "POST",
        body: JSON.stringify({}),
      })
        .then((result) => {
          showToast(`Queued ${result.jobs?.length || 0} job${result.jobs?.length === 1 ? '' : 's'} from revision ${result.revision}.`);
          state.workflowsLoaded = false;
          void loadWorkflows();
          render();
        })
        .catch((error) => {
          showToast(`Failed to run workflow: ${error.message}`);
        });
      return true;
    }
    if (name === "workflow-revision") {
      const workflow = state.workflows[Number(value)];
      if (!workflow) return true;
      const dir = Number(button.dataset.dir);
      const targetRev = (workflow.revision || 1) + dir;
      if (targetRev < 1) return true;
      loadRevisionDiff(workflow.id, targetRev);
      return true;
    }
    if (name === "workflow-publish") {
      const workflow = state.workflows[Number(value)];
      if (!workflow) return true;
      if (!window.confirm(`Publish workflow ${workflow.name || workflow.id}? This will make it available for runs.`)) return true;
      apiJson(`/api/workflows/${workflow.id}/publish`, { method: "POST" })
        .then((result) => {
          showToast(`Published ${result.id || workflow.id} revision ${result.revision}.`);
          state.workflowsLoaded = false;
          void loadWorkflows();
          render();
        })
        .catch((error) => {
          showToast(`Publish failed: ${error.message}`);
        });
      return true;
    }
    if (name === "rerun" && state.run) {
      if (state.mutating) {
        return true;
      }
      state.mutating = true;
      button.disabled = true;
      if (
        !window.confirm(
          `Re-run ${state.run.workflowName || state.run.workflowId || "this workflow"}? This creates a new job from the active workflow revision.`,
        )
      ) {
        state.mutating = false;
        button.disabled = false;
        return true;
      }
      try {
        const result = await apiJson(`/restart/${encodeURIComponent(state.run.jobId)}`, {
          method: "POST",
          body: JSON.stringify({}),
        });
        state.jobsLoaded = false;
        await loadJobs();
        showToast(`Re-run queued: #${result.id}`);
        window.location.hash = `/runs/${result.id}`;
      } catch (error) {
        showToast(`Re-run failed: ${error.message}`);
      } finally {
        state.mutating = false;
        button.disabled = false;
      }
      return true;
    }
    if (name === "cancel" && state.run) {
      if (state.mutating) {
        return true;
      }
      if (
        !["pending", "running"].includes(state.run.status) ||
        !window.confirm(`Cancel live run #${state.run.jobId}?`)
      ) {
        return true;
      }
      state.mutating = true;
      button.disabled = true;
      try {
        await apiJson(`/api/jobs/${encodeURIComponent(state.run.jobId)}/cancel`, { method: "POST" });
        showToast(`Run #${state.run.jobId} cancelled.`);
        await liveRunPage(state.run.jobId);
        state.jobsLoaded = false;
        await loadJobs();
      } catch (error) {
        showToast(`Cancel failed: ${error.message}`);
      } finally {
        state.mutating = false;
        button.disabled = false;
      }
      return true;
    }
    return false;
  };

  const setupEvents = () => {
    if (events) {
      return;
    }
    events = new EventSource("/api/events");
    events.addEventListener("jobs.available", () => {
      state.jobsLoaded = false;
      void loadJobs().then(() => {
        if (route().path === "/runs") {
          renderRuns();
        }
      });
    });
    events.addEventListener("jobs.changed", (event) => {
      let data = {};
      try {
        data = JSON.parse(event.data || "{}");
      } catch {
        /* Refresh the list even if an event payload is malformed. */
      }
      state.jobsLoaded = false;
      void loadJobs().then(() => {
        if (route().path === "/runs") {
          renderRuns();
        }
      });
      if (state.run && (!data.jobId || String(data.jobId) === String(state.run.jobId))) {
        void liveRunPage(state.run.jobId);
      }
    });
    events.onerror = () => {
      /* EventSource retries transient disconnects automatically. */
    };
    pollTimer = window.setInterval(() => {
      state.jobsLoaded = false;
      void loadJobs().then(() => {
        if (route().path === "/runs") {
          renderRuns();
        }
      });
    }, 60_000);
  };

  document.addEventListener("click", async (event) => {
    const handled = await action(event);
    if (handled) {
      event.preventDefault();
    }
  });
  document.addEventListener("submit", (event) => {
    if (event.target?.id === "new-workflow-form") {
      event.preventDefault();
      const name = document.getElementById("new-workflow-name")?.value.trim();
      const id = document.getElementById("new-workflow-id")?.value.trim().toLowerCase();
      const enabled = document.getElementById("new-workflow-enabled")?.checked;
      const source = document.getElementById("new-workflow-source")?.value.trim();
      if (!name || !id || !source) {
        showToast("Please fill in all fields (name, id, and source).");
        return;
      }
      if (!/^[a-z0-9-]+$/.test(id)) {
        showToast("Workflow ID can only contain lowercase letters, numbers, and hyphens.");
        return;
      }
      apiJson(`/api/workflows/${id}`, {
        method: "POST",
        body: JSON.stringify({ sourceYaml: source, enabled }),
      })
        .then(() => {
          showToast(`Created workflow ${id}.`);
          state.workflowsLoaded = false;
          void loadWorkflows();
          render();
        })
        .catch((error) => {
          showToast(`Failed to create workflow: ${error.message}`);
        });
    }
  });
  document.addEventListener("input", (event) => {
    if (event.target.id === "run-search") {
      state.search = event.target.value;
      state.page = 1;
      renderRunsTable();
    }
    if (event.target.id === "log-search") {
      state.logSearch = event.target.value;
      if (state.run) {
        renderLiveLog(state.run.steps?.[state.step]?.logContent || "");
      }
    }
  });
  document.addEventListener("change", (event) => {
    if (event.target.id === "workflow-filter") {
      state.workflow = event.target.value;
      state.page = 1;
      renderRunsTable();
    }
    if (event.target.id === "worker-filter") {
      state.worker = event.target.value;
      state.page = 1;
      renderRunsTable();
    }
    if (event.target.id === "compact-setting") {
      document.body.classList.toggle("compact", event.target.checked);
      localStorage.setItem("flow-concept-compact", String(event.target.checked));
    }
    if (event.target.id === "wrap-setting") {
      state.wrap = event.target.checked;
      localStorage.setItem("flow-concept-wrap", String(event.target.checked));
    }
  });
  window.addEventListener("hashchange", () => {
    state.run = null;
    void render();
  });
  window.addEventListener("beforeunload", () => {
    events?.close();
    window.clearInterval(pollTimer);
  });
  document.querySelectorAll("[data-icon]").forEach((node) => {
    node.innerHTML = icon(node.dataset.icon);
  });
  document.body.classList.toggle("compact", localStorage.getItem("flow-concept-compact") === "true");
  state.wrap = localStorage.getItem("flow-concept-wrap") === "true";
  const initialQuery = route().query;
  state.workflow = initialQuery.get("workflow") || "all";
  state.search = initialQuery.get("search") || "";
  if (["all", "running", "failed", "success"].includes(initialQuery.get("status"))) {
    state.status = initialQuery.get("status");
  }
  main.innerHTML = `${pageHeading("Runs", "Runs")}<div class="empty-state">${icon("clock")}<p>Loading runs…</p></div>`;
  setupEvents();
  void Promise.all([loadWorkflows(), loadJobs()]).then(() => {
    state.jobsLoaded = true;
    void render();
  });
}

const loadRevisionDiff = async (workflowId, revision) => {
  try {
    const current = await apiJson(`/api/workflows/${workflowId}?revision=${revision}`);
    const previous = revision > 1 ? await apiJson(`/api/workflows/${workflowId}?revision=${revision - 1}`) : null;
    const sourceDiff = renderRevisionDiff(previous?.sourceYaml ?? null, current.sourceYaml);
    openDialog(
      `Workflow ${current.name || current.id}`,
      `<p class="dialog-description">${current.name || current.id} — Revision ${current.revision}</p><div class="source-view"><pre>${sourceDiff}</pre></div><div class="dialog-footer"><button class="button" data-action="close-dialog">Close</button></div>`,
    );
  } catch (error) {
    showToast(`Failed to load revision diff: ${error.message}`);
  }
};

const renderRevisionDiff = (previousSource, currentSource) => {
  if (previousSource === null) return `<span class="text-emerald-300">+ ${escape(currentSource)}</span>\n`;
  return diffLines(previousSource, currentSource).map((part) => {
    const className = part.added ? 'text-emerald-300 bg-emerald-500/10' : part.removed ? 'text-rose-300 bg-rose-500/10' : 'text-gray-300';
    const prefix = part.added ? '+ ' : part.removed ? '- ' : '  ';
    return part.value.split('\n').filter((line, index, lines) => index < lines.length - 1 || line).map((line) => `<span class="block ${className}">${prefix}${escape(line)}</span>`).join('');
  }).join('');
};

const route = () => {
