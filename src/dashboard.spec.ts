import { describe, expect, it } from 'vitest';
import { generateDashboardHtml, toDashboardJobs } from './dashboard.js';

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
    const stateSource = html.match(/<script state>(.*?)<\/script>/s)?.[1];

    expect(JSON.parse(stateSource!)).toEqual({ jobs, hasMore: true });
    expect(html).toContain('`/api/jobs?afterId=${afterId}&limit=500`');
    expect(html).toContain("new Set(['success', 'failed', 'cancelled'])");
    expect(html).toContain('Math.max(0, Math.min(...activeIds) - 1)');
    expect(html).toContain('new Map(jobs.value.map((job) => [job.id, job]))');
    expect(html).toContain('Array.from(merged.values()).sort');
    expect(html).toContain('`/api/jobs?beforeId=${beforeId}`');
    expect(html).toContain('on-click="loadMore()"');
    expect(html).toContain("new EventSource('/api/events')");
    expect(html).toContain('href="/workflows"');
    expect(html).toContain("if=\"refreshError\"");
    expect(html).not.toContain('System operational');
    expect(html).toContain("addEventListener('jobs.available', refreshJobs)");
    expect(html).toContain("addEventListener('jobs.changed', refreshJobs)");
    expect(html).toContain('setInterval(refreshJobs, 60000)');
    expect(html).not.toContain('http-equiv="refresh"');
  });
});
