import { describe, expect, it } from 'vitest';
import { generateDashboardHtml, toDashboardJobs } from './dashboard.js';
import dashboardSetup from './dashboard.mjs?raw';

const row = {
  id: 7,
  workflow_id: 'deploy',
  status: 'running',
  worker_id: 'worker-1',
  created_at: '2026-09-04 12:00:00',
  updated_at: '2026-09-04 12:00:05',
  payload: '{"secret":"not exposed"}',
  report: '{"logs":"not exposed"}',
};

describe('dashboard', () => {
  it('creates a public job view without payloads or reports', () => {
    expect(toDashboardJobs([row])).toEqual([
      {
        id: 7,
        workflowId: 'deploy',
        status: 'running',
        workerId: 'worker-1',
        createdAt: '2026-09-04 12:00:00',
        updatedAt: '2026-09-04 12:00:05',
      },
    ]);
  });

  it('hydrates a li3 app and refreshes from server events', () => {
    const jobs = toDashboardJobs([row]);
    const html = generateDashboardHtml(jobs, true);
    expect(html).not.toContain('<script state>');
    expect(html).toContain('<script setup src="/dashboard.mjs"></script>');
    expect(dashboardSetup).toContain('void refreshJobs()');
    expect(dashboardSetup).toContain("new URLSearchParams(window.location.search).get('search')");
    expect(dashboardSetup).toContain('history.pushState(null');
    expect(dashboardSetup).toContain("params.set('search', value)");
    expect(dashboardSetup).toContain('`/api/jobs?afterId=${afterId}&limit=100${filterQuery}`');
    expect(dashboardSetup).toContain("new Set(['success', 'failed', 'cancelled'])");
    expect(dashboardSetup).toContain('Math.max(0, Math.min(...activeIds) - 1)');
    expect(dashboardSetup).toContain('new Map(jobs.value.map((job) => [job.id, job]))');
    expect(dashboardSetup).toContain('Array.from(merged.values()).sort');
    expect(dashboardSetup).toContain('`/api/jobs?beforeId=${beforeId}${filterQuery}`');
    expect(html).toContain('on-click="loadMore()"');
    expect(html).toContain('Filter: name:cloud-cli/* or text search');
    expect(html).toContain('on-submit.prevent="applyFilter()"');
    expect(html).toContain('on-input="setFilter($event)"');
    expect(html).toContain('Showing {{ jobs.length }} jobs matching');
    expect(dashboardSetup).toContain('encodeURIComponent(activeFilter.value)');
    expect(dashboardSetup).toContain('if (searchInProgress && !isSearch) return');
    expect(dashboardSetup).toContain('generation !== refreshGeneration');
    expect(html).toContain('<lucide-icon icon="search" size="16"></lucide-icon>');
    expect(html).toContain('<lucide-icon icon="x" size="15"></lucide-icon>');
    expect(dashboardSetup).toContain("new EventSource('/api/events')");
    expect(dashboardSetup).toContain('/api/push/public-key');
    expect(html).toContain('https://sodium.static.apphor.de/lucide-icon.html');
    expect(html).toContain('<app-header');
    expect(html).toContain('href="/app-header.html"');
    expect(html).not.toContain('lastUpdated');
    expect(html).toContain('class="block p-4 bg-gray-900/60 hover:bg-gray-800/40');
    expect(html).toContain('View Trace</a');
    expect(html).not.toContain('>Trace</a>');
    expect(html).toContain("if=\"refreshError\"");
    expect(html).not.toContain('System operational');
    expect(dashboardSetup).toContain("addEventListener('jobs.available', refreshJobs)");
    expect(dashboardSetup).toContain("addEventListener('jobs.changed', refreshJobs)");
    expect(dashboardSetup).toContain('setInterval(refreshJobs, 60000)');
    expect(html).toContain('href="/manifest.webmanifest"');
    expect(dashboardSetup).toContain("register('/service-worker.js')");
    expect(dashboardSetup).toContain('Notification.requestPermission()');
    expect(dashboardSetup).toContain('registration.showNotification(');
    expect(dashboardSetup).toContain("!terminalStatuses.has(previousStatus) && terminalStatuses.has(job.status)");
    expect(html).not.toContain('http-equiv="refresh"');
  });
});
