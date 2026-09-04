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

  it('hydrates a li3 app and polls the jobs API every five seconds', () => {
    const jobs = toDashboardJobs([row]);
    const html = generateDashboardHtml(jobs);
    const stateSource = html.match(/<script state>(.*?)<\/script>/s)?.[1];

    expect(JSON.parse(stateSource!)).toEqual({ jobs });
    expect(html).toContain("fetch('/api/jobs'");
    expect(html).toContain('setInterval(refreshJobs, 5000)');
    expect(html).not.toContain('http-equiv="refresh"');
  });
});
