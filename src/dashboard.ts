import dashboardTemplate from './dashboard.html?raw';
import { serializeHtmlState } from './html-state.js';

export interface DashboardJob {
  id: number;
  workflowId: string;
  status: string;
  workerId: string | null;
  createdAt: string;
  updatedAt: string;
}

export function toDashboardJobs(rows: any[]): DashboardJob[] {
  return rows.map((row) => ({
    id: row.id,
    workflowId: row.workflow_id,
    status: row.status,
    workerId: row.worker_id || null,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  }));
}

export function generateDashboardHtml(jobs: DashboardJob[], hasMore = false): string {
  return dashboardTemplate.replace('__DASHBOARD_STATE__', () => serializeHtmlState({ jobs, hasMore }));
}
