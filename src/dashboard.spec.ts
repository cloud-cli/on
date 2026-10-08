import { describe, expect, it } from "vitest";
import { generateDashboardHtml, toDashboardJobs } from "./dashboard.js";
import dashboardSetup from "./dashboard.mjs?raw";

const row = {
  id: 7,
  workflow_id: "deploy",
  status: "running",
  worker_id: "worker-1",
  created_at: "2026-09-04 12:00:00",
  updated_at: "2026-09-04 12:00:05",
  payload: '{"secret":"not exposed"}',
  report: '{"logs":"not exposed"}',
};

describe("dashboard", () => {
  it("creates a public job view without payloads or reports", () => {
    expect(toDashboardJobs([row])).toEqual([
      {
        id: 7,
        workflowId: "deploy",
        status: "running",
        statusLabel: "Running",
        workerId: "worker-1",
        createdAt: "2026-09-04 12:00:00",
        updatedAt: "2026-09-04 12:00:05",
      },
    ]);
  });

  it("precomputes human-readable status labels for template-safe interpolation", () => {
    const jobs = toDashboardJobs([
      { ...row, status: "in_progress" },
      { ...row, id: 8, status: "timed-out" },
    ]);

    expect(jobs.map((job) => job.statusLabel)).toEqual(["In progress", "Timed out"]);
  });

  it("hydrates a li3 app and refreshes from server events", () => {
    const jobs = toDashboardJobs([row]);
    const html = generateDashboardHtml(jobs, true);
    expect(html).not.toContain("<script state>");
    expect(html).toContain('<script setup src="/dashboard.mjs"></script>');
    expect(dashboardSetup).toContain("void refreshJobs(true)");
    expect(dashboardSetup).toContain('params.get("search")?.trim()');
    expect(dashboardSetup).toContain("history.pushState(null");
    expect(dashboardSetup).toContain('params.set("search", value)');
    expect(dashboardSetup).toContain("`/api/jobs?afterId=${afterId}&limit=100${filterQuery}${workflowQuery}`");
    expect(dashboardSetup).toContain('new Set(["success", "failed", "cancelled"])');
    expect(dashboardSetup).toContain("Math.max(0, Math.min(...activeIds) - 1)");
    expect(dashboardSetup).toContain("new Map(jobs.value.map((job) => [job.id, job]))");
    expect(dashboardSetup).toContain("Array.from(merged.values()).sort");
    expect(dashboardSetup).toContain("`/api/jobs?beforeId=${beforeId}${filterQuery}${workflowQuery}`");
    expect(html).toContain('on-click="previousPage()"');
    expect(html).toContain('on-click="nextPage()"');
    expect(html).toContain("Search runs");
    expect(html).toContain('on-submit.prevent="applyFilter()"');
    expect(html).toContain('on-input="setFilter($event)"');
    expect(html).toContain("All workflows");
    expect(dashboardSetup).toContain("encodeURIComponent(activeFilter.value)");
    expect(dashboardSetup).toContain("/^[A-Za-z0-9_-]+:.+$/.test(activeFilter.value)");
    expect(dashboardSetup).toContain("if (searchInProgress && !isSearch) return");
    expect(dashboardSetup).toContain("generation !== refreshGeneration");
    expect(html).toContain("Filter runs by status");
    expect(html).toContain(
      "statusFilter === tab.status ? 'rounded-full border border-flow-primary bg-flow-primary px-3 py-1.5 text-sm font-semibold text-white'",
    );
    expect(html).toContain("attr-aria-pressed=\"statusFilter === tab.status ? 'true' : 'false'\"");
    expect(html).toContain('bind-class="statusClass(job.status)"');
    expect(html).toContain('bind-icon="statusIcon(job.status)"');
    expect(html).toContain("{{ job.statusLabel }}");
    expect(html).not.toContain("{{ sentence(job.status)");
    expect(dashboardSetup).toContain("border-rose-300 bg-rose-100 text-rose-800");
    expect(dashboardSetup).toContain("border-emerald-300 bg-emerald-100 text-emerald-800");
    expect(dashboardSetup).toContain("border-amber-300 bg-amber-100 text-amber-900");
    expect(dashboardSetup).toContain("border-blue-300 bg-blue-100 text-blue-800");
    expect(html).toContain("ml-2 inline-flex items-center gap-1 rounded-full");
    expect(html).toContain('role="status"');
    expect(dashboardSetup).toContain('new EventSource("/api/events")');
    expect(dashboardSetup).toContain("/api/push/public-key");
    expect(html).toContain("https://sodium.static.apphor.de/lucide-icon.html");
    expect(html).not.toContain("Runs</h1>");
    expect(html).not.toContain("Activity</p>");
    expect(html).not.toContain("lastUpdated");
    expect(html).toContain("workflowName(job.workflowId)");
    expect(html).toContain("job.updatedAt");
    expect(html).not.toContain("{{ job.workflowId }}");
    expect(html).toContain('if="refreshError"');
    expect(html).not.toContain("System operational");
    expect(dashboardSetup).toContain('addEventListener("jobs.available", refreshJobs)');
    expect(dashboardSetup).toContain('addEventListener("jobs.changed", refreshJobs)');
    expect(dashboardSetup).toContain("workflowId=${encodeURIComponent(workflowFilter.value)}");
    expect(dashboardSetup).toContain('load("/api/workflows", "workflows"');
    expect(dashboardSetup).toContain('load("/api/workers", "workers"');
    expect(dashboardSetup).toContain("setInterval(refreshJobs, 60000)");
    expect(html).toContain('href="/manifest.webmanifest"');
    expect(dashboardSetup).toContain('register("/service-worker.js")');
    expect(dashboardSetup).toContain("Notification.requestPermission()");
    expect(dashboardSetup).toContain("registration.showNotification(");
    expect(dashboardSetup).toContain("!terminalStatuses.has(previousStatus) && terminalStatuses.has(job.status)");
    expect(html).not.toContain('http-equiv="refresh"');
  });
});
