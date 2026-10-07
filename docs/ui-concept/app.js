/* global document, window, localStorage, navigator, URL, Blob, setTimeout, clearTimeout */

const paths = {
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
  chevron: '<path d="m9 6 6 6-6 6"/>',
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
  edit: '<path d="m16 5 3 3M4 20l4.5-1 10-10a2.1 2.1 0 0 0-3-3l-10 10Z"/><path d="M13.5 7.5 17 11"/>',
  external: '<path d="M14 4h6v6m-11 3L20 4"/><path d="M18 13v5a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h5"/>',
  box: '<path d="m12 3 9 5v9l-9 5-9-5V8Zm0 9 9-4M3 8l9 4v10M7.5 5.5l9 5"/>',
  history: '<path d="M3 3v6h6M3.6 9a9 9 0 1 1-.2 6M12 7v5l3 2"/>',
  keyboard:
    '<rect x="2" y="5" width="20" height="14" rx="2"/><path d="M6 9h.01M10 9h.01M14 9h.01M18 9h.01M6 12h.01M10 12h.01M14 12h.01M18 12h.01M7 15h10"/>',
  close: '<path d="m6 6 12 12M6 18 18 6"/>',
  alert: '<path d="m12 3 10 18H2Z"/><path d="M12 9v5m0 3h.01"/>',
  lock: '<rect x="5" y="10" width="14" height="11" rx="2"/><path d="M8 10V6a4 4 0 0 1 8 0v4m-4 5v2"/>',
  stop: '<rect x="5" y="5" width="14" height="14" rx="2"/>',
  info: '<circle cx="12" cy="12" r="9"/><path d="M12 11v6m0-10h.01"/>',
};
const icon = (name) =>
  `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${
    paths[name] || paths.runs
  }</svg>`;
const escape = (value) =>
  String(value).replace(
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
  `<span class="status-icon ${status}">${icon(status === "success" ? "check" : status)}</span>`;
const badge = (status) => `<span class="status ${status}">${statusIcon(status)}${labels[status]}</span>`;
const workflows = [
  {
    id: "build-docker-image",
    name: "Build Docker image",
    description: "Build, test, and publish a container image to the registry.",
    labels: ["docker", "linux"],
    steps: ["Checkout repository", "Install dependencies", "Run tests", "Build image", "Push to registry"],
  },
  {
    id: "build-publish-npm",
    name: "Build & publish npm",
    description: "Validate packages and publish a new release to npm.",
    labels: ["node", "linux"],
    steps: ["Checkout repository", "Install dependencies", "Run tests", "Build package", "Publish to npm"],
  },
  {
    id: "deploy-production",
    name: "Deploy production",
    description: "Release the latest application and verify service health.",
    labels: ["main-server", "linux"],
    steps: ["Checkout repository", "Pull image", "Verify configuration", "Deploy service", "Health check"],
  },
  {
    id: "quality-checks",
    name: "Quality checks",
    description: "Type checking, linting, and tests for every pull request.",
    labels: ["node", "linux"],
    steps: ["Checkout repository", "Install dependencies", "Run tests", "Type check", "Lint"],
  },
];
const seed = [
  ["running", 0, "feat: add multi-platform builds", "feat/multi-platform", "a8f3c12", 93, "Just now", "on"],
  ["pending", 1, "chore: prepare September release", "main", "d72e8b1", 0, "1 min ago", "lithium"],
  ["failed", 0, "fix: resolve image build context", "main", "7bc91e4", 142, "4 min ago", "on"],
  ["success", 2, "feat: improve workflow navigation", "main", "f38ac02", 68, "12 min ago", "on"],
  ["success", 1, "fix: handle reconnect gracefully", "main", "c52d190", 104, "18 min ago", "sodium"],
  ["success", 3, "feat: add keyboard navigation", "feat/keyboard-nav", "8a12e6f", 46, "26 min ago", "lithium"],
  ["failed", 1, "chore: update dependency versions", "main", "e90b721", 38, "34 min ago", "lithium"],
  ["success", 0, "fix: restore health check endpoint", "main", "2a19d63", 127, "42 min ago", "auth"],
  ["success", 1, "feat: expose workflow metadata", "main", "b94d512", 88, "1 hr ago", "on"],
  ["success", 3, "test: cover retry boundaries", "fix/retries", "6fb841a", 59, "1 hr ago", "on"],
  ["cancelled", 0, "chore: rebuild base image", "main", "51ea273", 17, "2 hrs ago", "auth"],
  ["success", 2, "fix: improve session recovery", "main", "832df1a", 62, "2 hrs ago", "auth"],
  ["success", 3, "refactor: simplify component lifecycle", "main", "27d1c98", 71, "3 hrs ago", "lithium"],
  ["success", 1, "chore: release patch version", "main", "92dc128", 96, "3 hrs ago", "sodium"],
  ["success", 0, "feat: cache dependency layers", "main", "bd5201c", 112, "4 hrs ago", "on"],
  ["success", 2, "fix: persist worker labels", "main", "876da42", 65, "5 hrs ago", "on"],
];
let jobs = seed.map(([status, workflow, message, branch, commit, seconds, time, repo], index) => ({
  id: 2856 - index,
  status,
  workflow: workflows[workflow],
  message,
  branch,
  commit,
  seconds,
  time,
  repo,
  worker: status === "pending" ? null : "alpha",
  attempt: 1,
  parent: null,
}));
const state = {
  search: "",
  status: "all",
  workflow: "all",
  branch: "all",
  page: 1,
  step: null,
  detailTab: "logs",
  logQuery: "",
  wrap: false,
};
const main = document.querySelector("#main");
const dialog = document.querySelector("#dialog");
let toastTimer;
let previousRoute = "";

function duration(seconds) {
  if (!seconds) {
    return "—";
  }
  return `${Math.floor(seconds / 60) ? `${Math.floor(seconds / 60)}m ` : ""}${seconds % 60}s`;
}
function toast(message) {
  const element = document.querySelector("#toast");
  clearTimeout(toastTimer);
  element.textContent = message;
  element.hidden = false;
  toastTimer = setTimeout(() => {
    element.hidden = true;
  }, 4500);
}
function route() {
  const [path, query = ""] = window.location.hash.slice(1).split("?");
  return { path: path || "/runs", query: new URL(`https://example.test/?${query}`).searchParams };
}
function currentJob() {
  return jobs.find((job) => job.id === Number(route().path.split("/")[2]));
}
function updateFilterUrl() {
  const params = new URL("https://example.test").searchParams;
  for (const key of ["search", "status", "workflow", "branch", "page"]) {
    if (state[key] !== "" && state[key] !== "all" && state[key] !== 1) {
      params.set(key, state[key]);
    }
  }
  window.history.replaceState(
    null,
    "",
    `${window.location.pathname}${window.location.search}#/runs${params.size ? `?${params}` : ""}`,
  );
}
function readFilters() {
  const { query } = route();
  state.search = query.get("search") || "";
  state.status = ["all", "running", "failed", "success"].includes(query.get("status")) ? query.get("status") : "all";
  state.workflow = workflows.some((workflow) => workflow.id === query.get("workflow")) ? query.get("workflow") : "all";
  state.branch = ["main", "feature"].includes(query.get("branch")) ? query.get("branch") : "all";
  const page = Number(query.get("page"));
  state.page = Number.isSafeInteger(page) && page > 0 ? page : 1;
}
function navigation(page) {
  document.querySelector("#navigation").innerHTML = [
    ["runs", "Runs", "runs"],
    ["workflows", "Workflows", "workflow"],
    ["settings", "Settings", "settings"],
  ]
    .map(
      ([id, title, symbol]) =>
        `<a href="#/${id}" class="nav-item flex items-center gap-[10px] rounded-md px-[14px] py-3 text-xs font-medium text-flow-muted hover:bg-flow-subtle max-[900px]:justify-center max-[900px]:px-[10px] max-[900px]:py-[13px] max-[600px]:flex-1 max-[600px]:flex-col max-[600px]:gap-1 max-[600px]:rounded-none max-[600px]:px-[6px] max-[600px]:pt-[9px] max-[600px]:pb-[6px] max-[600px]:text-[10px] ${id === page ? "active bg-[#e8efdf] text-[#344d29] max-[600px]:bg-transparent max-[600px]:text-[#41602f]" : ""}" ${
          id === page ? 'aria-current="page"' : ""
        } aria-label="${title}">${icon(symbol).replace("<svg ", '<svg class="h-[17px] w-[17px] shrink-0 max-[600px]:h-[18px] max-[600px]:w-[18px]" ')}<span class="nav-label max-[900px]:hidden max-[600px]:block">${title}</span>${
          id === "runs"
            ? `<span class="nav-count ml-auto rounded bg-[#e2e8dc] px-1.5 py-0.5 text-[13px] max-[900px]:hidden">${
                jobs.filter((job) => ["running", "pending"].includes(job.status)).length
              }</span>`
            : ""
        }</a>`,
    )
    .join("");
  document.title = `${page[0].toUpperCase() + page.slice(1)} · Flow`;
}
function runsPage() {
  main.innerHTML = `<div class="mb-7 flex justify-end"><button class="button primary" data-action="new-run">${icon(
    "plus",
  )}Run workflow</button></div>
    <section aria-labelledby="recent-runs"><div class="section-heading"><h2 id="recent-runs">Runs <span class="count">${
      jobs.length
    }</span></h2></div>
    <div class="filters"><label class="search-box">${icon(
      "search",
    )}<span class="sr-only">Search runs</span><input id="run-search" type="search" value="${escape(
      state.search,
    )}" placeholder="Search runs, commits, or repositories…" autocomplete="off"/><kbd aria-hidden="true">/</kbd></label>
    <select id="workflow-filter" class="select-filter" aria-label="Filter by workflow"><option value="all">All workflows</option>${workflows
      .map(
        (workflow) =>
          `<option value="${workflow.id}" ${state.workflow === workflow.id ? "selected" : ""}>${workflow.name}</option>`,
      )
      .join("")}</select>
    <select id="branch-filter" class="select-filter" aria-label="Filter by branch"><option value="all">All branches</option><option value="main" ${
      state.branch === "main" ? "selected" : ""
    }>main</option><option value="feature" ${
      state.branch === "feature" ? "selected" : ""
    }>Feature branches</option></select></div>
    <div id="run-results"></div></section>
    <div class="attention-strip">${icon("alert")}<p><strong>${
      jobs.filter((job) => job.status === "failed").length
    } failed runs</strong><span>A little attention goes a long way.</span></p><button class="text-button" data-action="filter-failed">Review failures ${icon(
      "arrow",
    )}</button></div>`;
  renderResults();
}
function filteredJobs(includeStatus = true) {
  return jobs.filter((job) => {
    const search = state.search.trim().toLowerCase();
    const qualifier = search.match(/^([a-z0-9_-]+):(.+)$/);
    const text = [job.id, job.message, job.workflow.id, job.workflow.name, job.repo, job.commit, job.branch]
      .join(" ")
      .toLowerCase();
    const repository = String(job.repo || "").toLowerCase();
    const fullRepository = repository.includes("/") ? repository : `cloud-cli/${repository}`;
    const owner = fullRepository.split("/")[0];
    const qualifiedValue = qualifier
      ? qualifier[1] === "owner"
        ? owner
        : qualifier[1] === "repo"
          ? fullRepository
          : String(job.inputs?.[qualifier[1]] ?? job[qualifier[1]] ?? "").toLowerCase()
      : "";
    return (
      (qualifier ? qualifiedValue.includes(qualifier[2]) : text.includes(search)) &&
      (state.workflow === "all" || job.workflow.id === state.workflow) &&
      (state.branch === "all" || (state.branch === "main" ? job.branch === "main" : job.branch !== "main")) &&
      (!includeStatus ||
        state.status === "all" ||
        (state.status === "running" ? ["pending", "running"].includes(job.status) : job.status === state.status))
    );
  });
}
function renderResults() {
  const filtered = filteredJobs();
  const all = filteredJobs(false);
  const pages = Math.max(1, Math.ceil(filtered.length / 8));
  state.page = Math.min(pages, state.page);
  const visible = filtered.slice((state.page - 1) * 8, state.page * 8);
  document.querySelector("#run-results").innerHTML =
    `<div class="filter-tabs" role="group" aria-label="Filter by run status">${[
      ["all", "All runs"],
      ["running", "In progress"],
      ["failed", "Failed"],
      ["success", "Passed"],
    ]
      .map(
        ([value, label]) =>
          `<button class="filter-tab ${
            state.status === value ? "active" : ""
          }" data-action="status-filter" data-value="${value}" aria-pressed="${
            state.status === value
          }">${label}<span class="count">${
            all.filter(
              (job) =>
                value === "all" ||
                (value === "running" ? ["pending", "running"].includes(job.status) : job.status === value),
            ).length
          }</span></button>`,
      )
      .join("")}</div>
    ${
      visible.length
        ? `<table class="run-table"><caption class="sr-only">Workflow runs, newest first</caption><thead><tr><th scope="col">Workflow / commit</th><th scope="col">Status</th><th scope="col">Branch</th><th scope="col">Duration</th><th scope="col">Started</th></tr></thead><tbody>${visible
            .map(
              (job) =>
                `<tr><td><a class="run-link" href="#/runs/${job.id}" aria-label="Run ${job.id}: ${escape(
                  job.workflow.name,
                )}, ${labels[job.status]}">${statusIcon(job.status)}<span class="run-copy"><span class="run-title">${
                  job.workflow.name
                }</span><span class="run-subtitle"><span class="mono">#${
                  job.id
                }</span><span class="separator">·</span><span>cloud-cli/${
                  job.repo
                }</span><span class="separator">·</span><span class="mono">${
                  job.commit
                }</span></span></span></a></td><td>${badge(job.status)}</td><td><span class="branch">${icon(
                  "branch",
                )}${escape(job.branch)}</span></td><td><span class="mono duration">${duration(
                  job.seconds,
                )}</span></td><td>${job.time}</td></tr>`,
            )
            .join("")}</tbody></table>`
        : `<div class="empty-state">${icon(
            "search",
          )}<h3>No runs found</h3><p>Try a different search or clear your filters.</p><button class="button" data-action="clear-filters">Clear filters</button></div>`
    }
    <div class="table-footer"><span role="status">${
      filtered.length
        ? `${(state.page - 1) * 8 + 1}–${Math.min(state.page * 8, filtered.length)} of ${filtered.length} runs`
        : "0 runs"
    }</span><div class="pagination"><button class="button" data-action="prev-page" ${
      state.page === 1 ? "disabled" : ""
    }>${icon("back")}Previous</button><span>${
      state.page
    } / ${pages}</span><button class="button" data-action="next-page" ${
      state.page === pages ? "disabled" : ""
    }>Next${icon("arrow")}</button></div></div><div class="table-hint">${icon(
      "info",
    )}Open a run to explore its steps, logs, and execution history.</div>`;
}
function stepsFor(job) {
  return job.workflow.steps.map((name, index) => {
    let status = "success";
    if (job.status === "failed") {
      status = index < 2 ? "success" : index === 2 ? "failed" : "skipped";
    }
    if (job.status === "running") {
      status = index < 3 ? "success" : index === 3 ? "running" : "pending";
    }
    if (job.status === "pending") {
      status = "pending";
    }
    if (job.status === "cancelled") {
      status = index === 0 ? "success" : index === 1 ? "cancelled" : "skipped";
    }
    const seconds = ["skipped", "pending"].includes(status)
      ? 0
      : Math.round(job.seconds * [0.03, 0.24, 0.45, 0.2, 0.08][index]);
    return { name, status, seconds, index };
  });
}
function detailPage(job) {
  const steps = stepsFor(job);
  if (state.step === null) {
    state.step = Math.max(
      0,
      steps.findIndex((step) => ["failed", "running"].includes(step.status)),
    );
  }
  const active = ["running", "pending"].includes(job.status);
  main.innerHTML = `<a href="#/runs" class="back-link">${icon(
    "back",
  )}All runs</a><div class="page-heading run-heading"><div><h1>${statusIcon(job.status)}${
    job.workflow.name
  }</h1><p class="subtitle"><span class="mono">#${job.id}</span><span>·</span><span>${escape(
    job.message,
  )}</span></p></div><div class="heading-actions"><button class="button" data-action="download-logs">${icon(
    "download",
  )}Download logs</button><button class="button ${active ? "danger" : "primary"}" data-action="${
    active ? "cancel-run" : "rerun"
  }">${icon(active ? "stop" : "refresh")}${active ? "Cancel run" : "Re-run workflow"}</button></div></div>
    <section class="detail-meta" aria-label="Run metadata"><div><span class="meta-label">STATUS</span><span class="meta-value">${badge(
      job.status,
    )}</span></div><div><span class="meta-label">REPOSITORY / BRANCH</span><span class="meta-value">${icon(
      "branch",
    )}${escape(job.branch)}</span></div><div><span class="meta-label">COMMIT</span><span class="meta-value mono">${icon(
      "commit",
    )}${job.commit}</span></div><div><span class="meta-label">DURATION</span><span class="meta-value">${icon(
      "clock",
    )}${duration(job.seconds)}</span></div><div><span class="meta-label">WORKER</span><span class="meta-value">${icon(
      "server",
    )}${job.worker || "Awaiting worker"}${job.worker ? '<span class="tag">linux · x64</span>' : ""}</span></div></section>
    <div class="detail-tabs" role="group" aria-label="Run detail views">${[
      ["logs", "Logs & steps", "terminal"],
      ["inputs", "Inputs", "code"],
      ["artifacts", "Artifacts", "box"],
      ["history", "History", "history"],
    ]
      .map(
        ([value, title, symbol]) =>
          `<button data-action="detail-tab" data-value="${value}" class="${
            state.detailTab === value ? "active" : ""
          }" aria-pressed="${state.detailTab === value}">${icon(symbol)}${title}${
            value === "history" ? `<span class="count">${job.attempt}</span>` : ""
          }</button>`,
      )
      .join("")}</div>
    <div id="detail-content"></div>`;
  renderDetailContent(job);
}
function renderDetailContent(job) {
  const content = document.querySelector("#detail-content");
  if (state.detailTab === "inputs") {
    content.innerHTML = `<section class="source-view"><h3>Trigger inputs <span class="tag">${
      job.parent ? "manual restart" : "push event"
    }</span></h3><pre>${escape(
      JSON.stringify(
        {
          repository: `cloud-cli/${job.repo}`,
          ref: `refs/heads/${job.branch}`,
          commit: job.commit,
          workflow: job.workflow.id,
          triggered_by: job.parent ? "user:jamie" : "webhook:github",
        },
        null,
        2,
      ),
    )}</pre></section><section class="source-view" style="margin-top:20px"><h3>Workflow source · revision 12</h3><pre>${escape(
      workflowSource(job.workflow),
    )}</pre></section>`;
    return;
  }
  if (state.detailTab === "artifacts") {
    content.innerHTML =
      job.status === "success"
        ? `<section class="settings-section"><h2>Run artifacts <span class="count">1</span></h2><div class="setting-row"><div><strong>${icon(
            "box",
          )} build-manifest.json</strong><p>Sample build metadata · JSON</p></div><button class="button" data-action="artifact">${icon(
            "download",
          )}Download</button></div></section>`
        : `<div class="empty-state">${icon("box")}<h3>No artifacts yet</h3><p>${
            activeStatus(job)
              ? "Artifacts appear here when the run completes."
              : "This run did not produce any artifacts."
          }</p></div>`;
    return;
  }
  if (state.detailTab === "history") {
    const history = [];
    let current = job;
    while (current) {
      history.push(current);
      current = jobs.find((candidate) => candidate.id === current.parent);
    }
    content.innerHTML = `<section class="settings-section"><h2>Execution history</h2>${history
      .map(
        (entry) =>
          `<div class="setting-row"><div><strong><a href="#/runs/${entry.id}">Run #${entry.id} · Attempt ${
            entry.attempt
          }</a></strong><p>${
            entry.parent ? `Re-run of #${entry.parent} · Triggered by Jamie` : "Original run · Triggered by GitHub"
          } · ${entry.time}</p></div>${badge(entry.status)}</div>`,
      )
      .join("")}</section>`;
    return;
  }
  const steps = stepsFor(job);
  const selected = steps[state.step];
  content.innerHTML = `${
    job.status === "failed"
      ? `<div class="failure-banner">${icon(
          "alert",
        )}<div><strong>Run tests failed with exit code 1</strong><p>One test failed. The remaining steps were skipped.</p></div><button class="text-button" data-action="jump-error">Jump to error ${icon(
          "arrow",
        )}</button></div>`
      : ""
  }
    <section class="execution" aria-label="Execution steps and logs"><aside class="steps-panel" aria-label="Execution steps"><div class="steps-heading"><span>Execution steps</span><span class="mono">${
      steps.filter((step) => step.status === "success").length
    } / ${steps.length}</span></div>${steps
      .map(
        (step) =>
          `<button class="step-button ${state.step === step.index ? "active" : ""}" data-action="step" data-value="${
            step.index
          }" aria-pressed="${state.step === step.index}" aria-label="${step.name}, ${labels[step.status]}">${statusIcon(
            step.status,
          )}<span>${step.name}</span><span class="mono">${duration(step.seconds)}</span></button>`,
      )
      .join("")}<div class="step-count">${icon("clock")}Total duration ${duration(job.seconds)}</div></aside>
    <div class="log-panel"><div class="log-heading"><h3>${selected.name}<small>${
      selected.status === "failed" ? "exit code 1" : labels[selected.status]
    }</small></h3><div class="log-actions"><button class="icon-button" data-action="wrap" aria-label="Wrap log lines" aria-pressed="${
      state.wrap
    }" title="Wrap log lines">${icon(
      "wrap",
    )}</button><button class="icon-button" data-action="copy-log" aria-label="Copy step log" title="Copy step log">${icon(
      "copy",
    )}</button></div></div><label class="log-search">${icon(
      "search",
    )}<span class="sr-only">Search step log</span><input id="log-search" type="search" placeholder="Find in this step…" value="${escape(
      state.logQuery,
    )}"/><span id="log-matches"></span></label><div class="log-lines ${
      state.wrap ? "wrap" : ""
    }" id="log-lines" tabindex="0" aria-label="Step log output"></div><div class="log-bottom"><span>${
      selected.status === "failed"
        ? "Process exited with code 1"
        : activeStatus(job)
          ? "Sample execution output"
          : "End of step output"
    }</span><span class="mono">UTF-8</span></div></div></section>
    <div class="detail-bottom"><span>${icon("lock")}Logs are visible to workspace members.</span><span>cloud-cli/${
      job.repo
    }<span>·</span>Workflow revision 12<span>·</span>Attempt ${job.attempt}</span></div>`;
  renderLogs(job);
}
function activeStatus(job) {
  return ["pending", "running"].includes(job.status);
}
function logsFor(job, index) {
  const step = stepsFor(job)[index];
  if (step.status === "skipped") {
    return [{ text: "Step skipped because an earlier step did not complete.", type: "dim" }];
  }
  if (step.status === "pending") {
    return [{ text: "Waiting for a worker…", type: "dim" }];
  }
  if (step.status === "failed") {
    return [
      ["$ pnpm test", ""],
      ["> @cloud-cli/on test", "dim"],
      ["> vitest run", "dim"],
      ["", ""],
      [" RUN  v4.1.11 /workspace/cloud-cli/on", ""],
      ["", ""],
      [" ✓ src/config.spec.ts (8 tests) 14ms", "pass"],
      [" ✓ src/queue.spec.ts (12 tests) 31ms", "pass"],
      [" ❯ src/worker.spec.ts (6 tests | 1 failed) 89ms", "error"],
      ["   × worker > retries a failed job", "error"],
      ["", ""],
      [" FAIL  src/worker.spec.ts > worker > retries a failed job", "error"],
      [" AssertionError: expected 2 to equal 3", "error"],
      ["", ""],
      ["   Expected: 3", "pass"],
      ["   Received: 2", "error"],
      ["", ""],
      [" ❯ src/worker.spec.ts:142:28", ""],
      ["    140| await worker.retry(job);", "dim"],
      ["    141|", "dim"],
      ["    142| expect(job.attempts).toBe(3);", "error"],
      ["       |                      ^", "error"],
      ["", ""],
      [" Test Files  1 failed | 2 passed (3)", ""],
      ["      Tests  1 failed | 25 passed (26)", ""],
      ["   Duration  1.42s", "dim"],
      ["", ""],
      [" ELIFECYCLE  Test failed. See above for more details.", "error"],
    ].map(([text, type]) => ({ text, type }));
  }
  const logs =
    index === 0
      ? [
          `$ git clone https://github.com/cloud-cli/${job.repo}.git .`,
          "Cloning into '.'...",
          "remote: Enumerating objects: 184, done.",
          "remote: Compressing objects: 100% (92/92), done.",
          "Receiving objects: 100% (184/184), 148.2 KiB | 3.1 MiB/s, done.",
          `$ git checkout ${job.commit}`,
          `HEAD is now at ${job.commit} ${job.message}`,
          "",
          "✓ Repository ready.",
        ]
      : index === 1
        ? [
            "$ pnpm install --frozen-lockfile",
            "Lockfile is up to date, resolution step is skipped",
            "Progress: resolved 248, reused 248, downloaded 0, added 248",
            "",
            "✓ Dependencies installed from cache.",
            "Done in 2.4s.",
          ]
        : index === 2
          ? [
              "$ pnpm test",
              " RUN  v4.1.11 /workspace",
              "",
              " ✓ src/config.spec.ts (8 tests)",
              " ✓ src/queue.spec.ts (12 tests)",
              " ✓ src/worker.spec.ts (6 tests)",
              "",
              " Test Files  3 passed (3)",
              "      Tests  26 passed (26)",
              "",
              "✓ All tests passed.",
            ]
          : [
              `$ ${job.workflow.id === "build-docker-image" ? "docker build --tag app:latest ." : "pnpm build"}`,
              "#1 Loading build configuration",
              "#1 DONE 0.1s",
              "#2 Resolving dependencies",
              "#2 CACHED",
              "#3 Compiling source files",
              "#3 DONE 1.3s",
              "#4 Creating production bundle",
              ...(step.status === "running"
                ? ["#4 Building…"]
                : ["#4 DONE 0.8s", "", "✓ Step completed successfully."]),
            ];
  if (step.status === "cancelled") {
    logs.push("Run cancelled by Jamie.");
  }
  return logs.map((text) => ({ text, type: text.startsWith("✓") || text.includes(" passed") ? "pass" : "" }));
}
function renderLogs(job) {
  const logs = logsFor(job, state.step);
  const query = state.logQuery.toLowerCase();
  let matches = 0;
  document.querySelector("#log-lines").innerHTML = logs
    .map((line, index) => {
      let text = escape(line.text);
      const position = query ? line.text.toLowerCase().indexOf(query) : -1;
      if (position >= 0) {
        matches++;
        text = `${escape(line.text.slice(0, position))}<mark>${escape(
          line.text.slice(position, position + query.length),
        )}</mark>${escape(line.text.slice(position + query.length))}`;
      }
      return `<div class="log-line ${line.type}" ${
        line.type === "error" ? 'data-error="true"' : ""
      }><span class="line-number">${index + 1}</span><span class="log-time">12:04:${String(
        16 + Math.floor(index / 3),
      ).padStart(2, "0")}</span><span class="line-text">${text || " "}</span></div>`;
    })
    .join("");
  document.querySelector("#log-matches").textContent = query ? `${matches} matching lines` : "";
}
function workflowSource(workflow) {
  return `name: ${workflow.name}\nruns-on: [${workflow.labels.join(
    ", ",
  )}]\n\n# Illustrative workflow definition\nsteps:\n${workflow.steps
    .map(
      (name, index) =>
        `  - name: ${name}\n    run: ${
          [
            'git checkout "$COMMIT"',
            "pnpm install --frozen-lockfile",
            "pnpm test",
            "pnpm build",
            'echo "Release complete"',
          ][index]
        }`,
    )
    .join("\n")}`;
}
function workflowsPage() {
  main.innerHTML = `<div class="workflow-list">${workflows
    .map(
      (workflow, index) =>
        `<article class="workflow-item"><div class="workflow-header"><span class="workflow-name">${workflow.name}</span><span class="workflow-status success">Enabled</span></div><div class="workflow-meta"><span>v${workflow.revision || 1}</span><span>${workflow.steps.length} steps</span></div><div class="workflow-actions"><a class="button" href="#/runs?workflow=${workflow.id}" aria-label="View runs for ${workflow.name}" title="View runs">${icon(
          "runs",
        )}</a><button class="button" data-action="workflow-source" data-value="${index}" aria-label="View source for ${workflow.name}" title="View source">${icon(
          "code",
        )}</button></div></article>`,
    )
    .join("")}</div>`;
}
function workerCards() {
  return `<div class="cards">${[
    ["alpha", "main-server, docker", 36, 42, "1 / 4"],
    ["bravo", "node, linux", 12, 28, "0 / 4"],
    ["charlie", "docker, linux", 8, 21, "0 / 2"],
  ]
    .map(
      ([name, tags, cpu, memory, slots]) =>
        `<article class="worker-card"><div class="card-heading">${icon(
          "server",
        )}<h2>${name}</h2><span class="status success">Online</span></div><p class="card-description">Linux x64 · systemd runner</p><div class="card-details">${tags
          .split(", ")
          .map((tag) => `<span class="tag mono">${tag}</span>`)
          .join(
            "",
          )}</div><div class="worker-stats"><div><span class="meta-label">CPU <span>${cpu}%</span></span><div class="progress-track"><div class="progress-fill" style="width:${cpu}%"></div></div></div><div><span class="meta-label">Memory <span>${memory}%</span></span><div class="progress-track"><div class="progress-fill" style="width:${memory}%"></div></div></div></div><div class="card-footer"><span class="settings-note">${slots} slots in use</span><span class="settings-note">Sample snapshot</span></div></article>`,
    )
    .join("")}</div>`;
}
function getPreference(key) {
  try {
    return localStorage.getItem(`flow-concept-${key}`) === "true";
  } catch {
    return false;
  }
}
function settingsPage() {
  const timezone = localStorage.getItem("flow-concept-timezone") || "UTC";
  main.innerHTML = `<div class="page-heading"><div><h1>Settings</h1><p class="subtitle">The essentials for your workspace.</p></div></div><section class="settings-section"><h2>Preferences</h2><label class="setting-row"><span><strong>Compact run list</strong><span class="settings-note">Fit more activity on your screen.</span></span><input type="checkbox" id="compact-setting" ${
    getPreference("compact") ? "checked" : ""
  }/></label><label class="setting-row"><span><strong>Wrap log lines</strong><span class="settings-note">Keep long output within the log viewer.</span></span><input type="checkbox" id="wrap-setting" ${
    state.wrap ? "checked" : ""
  }/></label><label class="setting-row"><span><strong>Timezone</strong><span class="settings-note">Use this timezone for displayed dates.</span></span><select id="timezone-setting"><option ${timezone === "UTC" ? "selected" : ""}>UTC</option><option ${timezone === "America/Los_Angeles" ? "selected" : ""}>America/Los_Angeles</option><option ${timezone === "Europe/London" ? "selected" : ""}>Europe/London</option></select></label></section><section class="settings-section"><h2>Workers</h2><p class="settings-note">Execution capacity available to workflows.</p>${workerCards()}</section><section class="settings-section"><h2>${icon(
    "lock",
  )} Secrets</h2><p class="settings-note">Available to workflows. Values are never displayed in the dashboard.</p>${[
    "NPM_TOKEN",
    "REGISTRY_PASSWORD",
    "DEPLOY_KEY",
  ]
    .map(
      (name) =>
        `<div class="setting-row"><div class="min-w-0"><strong class="mono block max-w-[min(58vw,480px)] truncate" title="${name}">${name}</strong><p>Workspace secret · Example</p></div><span class="secret-value shrink-0" aria-label="Value hidden">••••••••••••</span></div>`,
    )
    .join(
      "",
    )}</section><section class="settings-section"><h2>Tokens</h2><p class="settings-note">Access tokens are hidden after creation.</p><div class="setting-row"><span>CI deploy token</span><span class="secret-value" aria-label="Token value hidden">••••••••••••</span></div></section><section class="settings-section"><h2>Admin roster</h2><div class="setting-row"><div><strong>Jamie Davis</strong><p>jamie@example.com</p></div><span class="workflow-status success">Admin</span></div></section><section class="settings-section"><h2>About</h2><p class="settings-note">An interactive design prototype based on Flow’s job list and run details. Run controls update this browser session. Display preferences are saved on this device.</p><div class="setting-row"><span class="settings-note">Explore without setup.</span><button class="button" data-action="shortcuts">${icon(
    "keyboard",
  )}Keyboard shortcuts</button></div></section>`;
}
function openDialog(title, body) {
  dialog.innerHTML = `<div class="dialog-heading"><h2 id="dialog-title">${title}</h2><button class="icon-button" data-action="close-dialog" aria-label="Close dialog">${icon(
    "close",
  )}</button></div>${body}`;
  if (!dialog.open) {
    dialog.showModal();
  }
}
function newRunDialog() {
  openDialog(
    "Run a workflow",
    `<p class="dialog-description">Choose what to run. We’ll take it from here.</p><form id="new-run-form"><label class="form-field"><span>Workflow</span><select name="workflow">${workflows
      .map((workflow) => `<option value="${workflow.id}">${workflow.name}</option>`)
      .join(
        "",
      )}</select></label><label class="form-field"><span>Branch</span><input name="branch" value="main" required maxlength="100" pattern="[a-zA-Z0-9._\\x2f\\x2d]+"/></label><p class="dialog-note">Prototype mode: creates a sample queued run in this session.</p><div class="dialog-footer"><button class="button" type="button" data-action="close-dialog">Cancel</button><button class="button primary" type="submit">${icon(
      "runs",
    )}Run workflow</button></div></form>`,
  );
}
function createRun(original, workflow, branch) {
  const job = {
    id: Math.max(...jobs.map((entry) => entry.id)) + 1,
    workflow,
    branch,
    status: "pending",
    message: original?.message || "Manually triggered workflow",
    commit: original?.commit || "a8f3c12",
    seconds: 0,
    time: "Just now",
    repo: original?.repo || "on",
    worker: null,
    parent: original?.id || null,
    attempt: original ? original.attempt + 1 : 1,
  };
  jobs.unshift(job);
  dialog.close();
  window.location.hash = `/runs/${job.id}`;
  toast(`Sample run #${job.id} queued.`);
}
function download(name, text) {
  const url = URL.createObjectURL(new Blob([text], { type: "text/plain;charset=utf-8" }));
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = name;
  anchor.click();
  setTimeout(() => {
    URL.revokeObjectURL(url);
  }, 1000);
}
function render() {
  const { path } = route();
  const page = path.split("/")[1] || "runs";
  const changed = previousRoute !== path;
  if (changed) {
    state.step = null;
    state.detailTab = "logs";
    state.logQuery = "";
  }
  previousRoute = path;
  navigation(["runs", "workflows", "settings"].includes(page) ? page : page === "workers" ? "settings" : "runs");
  if (path === "/runs") {
    readFilters();
    runsPage();
  } else if (page === "runs" && currentJob()) {
    detailPage(currentJob());
  } else if (page === "workflows") {
    workflowsPage();
  } else if (page === "workers") {
    settingsPage();
  } else if (page === "settings") {
    settingsPage();
  } else {
    main.innerHTML = `<div class="empty-state">${icon(
      "search",
    )}<h1>Run not found</h1><p>This run is not part of the sample workspace.</p><a class="button" href="#/runs">Back to runs</a></div>`;
  }
  if (changed) {
    window.scrollTo(0, 0);
    main.focus({ preventScroll: true });
  }
}
document.addEventListener("click", (event) => {
  if (event.target.closest('#profile-link[aria-disabled="true"]')) {
    event.preventDefault();
  }
});
document.addEventListener("click", async (event) => {
  const button = event.target.closest("[data-action]");
  if (!button) {
    return;
  }
  const { action, value } = button.dataset;
  const job = currentJob();
  if (action === "new-run") {
    newRunDialog();
  }
  if (action === "close-dialog") {
    dialog.close();
  }
  if (action === "filter-failed" || action === "status-filter") {
    state.status = action === "filter-failed" ? "failed" : value;
    state.page = 1;
    updateFilterUrl();
    renderResults();
    document.querySelector(`.filter-tab[data-value="${state.status}"]`).focus({ preventScroll: true });
  }
  if (action === "clear-filters") {
    Object.assign(state, { search: "", status: "all", workflow: "all", branch: "all", page: 1 });
    updateFilterUrl();
    runsPage();
    document.querySelector("#run-search").focus();
  }
  if (action === "prev-page" || action === "next-page") {
    state.page += action === "next-page" ? 1 : -1;
    updateFilterUrl();
    renderResults();
    document.querySelector(`button[data-action="${action}"]:not(:disabled)`)?.focus({ preventScroll: true });
  }
  if (action === "detail-tab") {
    state.detailTab = value;
    detailPage(job);
    document.querySelector(`[data-action="detail-tab"][data-value="${value}"]`).focus({ preventScroll: true });
  }
  if (action === "step") {
    state.step = Number(value);
    state.logQuery = "";
    renderDetailContent(job);
    document.querySelector(`[data-action="step"][data-value="${value}"]`).focus({ preventScroll: true });
  }
  if (action === "jump-error") {
    state.step = 2;
    state.logQuery = "";
    renderDetailContent(job);
    document.querySelector("[data-error]")?.scrollIntoView({ block: "nearest" });
    document.querySelector("#log-lines").focus({ preventScroll: true });
  }
  if (action === "wrap") {
    state.wrap = !state.wrap;
    document.querySelector("#log-lines").classList.toggle("wrap", state.wrap);
    button.setAttribute("aria-pressed", String(state.wrap));
  }
  if (action === "copy-log") {
    try {
      await navigator.clipboard.writeText(
        logsFor(job, state.step)
          .map((line) => line.text)
          .join("\n"),
      );
      toast("Step log copied.");
    } catch {
      toast("Clipboard unavailable. Use Download logs to save the output.");
    }
  }
  if (action === "download-logs") {
    download(
      `flow-run-${job.id}.log`,
      job.workflow.steps
        .map(
          (name, index) =>
            `=== ${name} ===\n${logsFor(job, index)
              .map((line) => line.text)
              .join("\n")}`,
        )
        .join("\n\n"),
    );
    toast("Run log downloaded.");
  }
  if (action === "artifact") {
    download(
      `run-${job.id}-build-manifest.json`,
      JSON.stringify({ sample: true, run: job.id, commit: job.commit, workflow: job.workflow.id }, null, 2),
    );
  }
  if (action === "rerun") {
    createRun(job, job.workflow, job.branch);
  }
  if (action === "cancel-run") {
    job.status = "cancelled";
    state.step = null;
    navigation("runs");
    detailPage(job);
    toast(`Sample run #${job.id} cancelled.`);
  }
  if (action === "workflow-source") {
    const workflow = workflows[Number(value)];
    openDialog(
      workflow.name,
      `<p class="dialog-description">Illustrative YAML · revision 12</p><div class="source-view"><pre>${escape(
        workflowSource(workflow),
      )}</pre></div><div class="dialog-footer"><button class="button" data-action="close-dialog">Close</button></div>`,
    );
  }
  if (action === "preferences") {
    window.location.hash = "/settings";
  }
  if (action === "shortcuts") {
    openDialog(
      "A few useful shortcuts",
      `<p class="dialog-description">Less clicking. More getting things done.</p><div class="shortcut-row"><span>Search runs</span><kbd>/</kbd></div><div class="shortcut-row"><span>Run a workflow</span><kbd>N</kbd></div><div class="shortcut-row"><span>Show shortcuts</span><kbd>?</kbd></div><div class="shortcut-row"><span>Close dialog</span><kbd>Esc</kbd></div><div class="dialog-footer"><button class="button primary" data-action="close-dialog">Got it</button></div>`,
    );
  }
});
document.addEventListener("input", (event) => {
  if (event.target.id === "run-search") {
    state.search = event.target.value;
    state.page = 1;
    updateFilterUrl();
    renderResults();
  }
  if (event.target.id === "log-search") {
    state.logQuery = event.target.value;
    renderLogs(currentJob());
  }
});
document.addEventListener("change", (event) => {
  if (["workflow-filter", "branch-filter"].includes(event.target.id)) {
    state[event.target.id === "workflow-filter" ? "workflow" : "branch"] = event.target.value;
    state.page = 1;
    updateFilterUrl();
    renderResults();
  }
  if (["compact-setting", "wrap-setting"].includes(event.target.id)) {
    const key = event.target.id === "compact-setting" ? "compact" : "wrap";
    if (key === "compact") {
      document.body.classList.toggle("compact", event.target.checked);
    } else {
      state.wrap = event.target.checked;
    }
    try {
      localStorage.setItem(`flow-concept-${key}`, event.target.checked);
      toast("Preference saved on this device.");
    } catch {
      toast("Preference applied for this session.");
    }
  }
  if (event.target.id === "timezone-setting") {
    localStorage.setItem("flow-concept-timezone", event.target.value);
  }
});
document.addEventListener("submit", (event) => {
  if (event.target.id === "new-run-form") {
    event.preventDefault();
    createRun(
      null,
      workflows.find((workflow) => workflow.id === event.target.elements.workflow.value),
      event.target.elements.branch.value.trim(),
    );
  }
});
document.addEventListener("keydown", (event) => {
  if (
    event.ctrlKey ||
    event.metaKey ||
    event.altKey ||
    event.target.closest('input,select,textarea,[contenteditable="true"]') ||
    dialog.open
  ) {
    return;
  }
  if (event.key === "/" && route().path === "/runs") {
    event.preventDefault();
    document.querySelector("#run-search").focus();
  }
  if (event.key.toLowerCase() === "n") {
    event.preventDefault();
    newRunDialog();
  }
  if (event.key === "?") {
    event.preventDefault();
    document.querySelector('[data-action="shortcuts"]').click();
  }
});
window.addEventListener("hashchange", render);
document.querySelectorAll("[data-icon]").forEach((element) => {
  element.innerHTML = icon(element.dataset.icon);
});
document.body.classList.toggle("compact", getPreference("compact"));
state.wrap = getPreference("wrap");
render();
