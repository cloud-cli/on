import runTemplate from './run.html?raw';
import { serializeHtmlState } from './html-state.js';
import type { JobPayload, JobRecord, StepReport, WorkflowExecutionReport, WorkflowStep } from './types.js';

const SENSITIVE_KEY =
  /(?:^|[_-])auth(?:entication)?(?:$|[_-])|access[_-]?key|api[_-]?key|authorization|cookie|credential|passphrase|password|private[_-]?key|secret|session(?:id)?|signing[_-]?key|token/i;

export interface RunView {
  jobId: string;
  parentId: string;
  workflowName: string;
  status: WorkflowExecutionReport['status'];
  durationMs: number;
  startedAt: string;
  finishedAt?: string;
  inputs: Record<string, unknown>;
  steps: StepReport[];
  artifacts: string[];
  canViewLogs: boolean;
}

export function buildRunView(
  job: JobRecord & Record<string, any>,
  logs: Record<string, string>,
  redact: (value: string) => string,
  steps: WorkflowStep[] = [],
  canViewLogs = true,
): RunView {
  const payload = JSON.parse(job.payload) as JobPayload;
  const report = job.report ? (JSON.parse(job.report) as WorkflowExecutionReport) : buildPendingReport(job, payload, steps);
  const status = job.status;

  return {
    jobId: String(job.id),
    parentId: String(report.parentId || job.parentId || ''),
    workflowName: redact(report.workflowName),
    status,
    durationMs: status === 'running' ? Math.max(0, Date.now() - Date.parse(report.startedAt)) : report.durationMs,
    startedAt: report.startedAt,
    finishedAt: report.finishedAt,
    inputs: sanitizeValue(report.inputs || {}, redact) as Record<string, unknown>,
    steps: (report.steps || []).map((step) => {
      const savedLog = Object.hasOwn(logs, step.id) && typeof logs[step.id] === 'string' ? logs[step.id] : '';
      return {
        id: step.id,
        name: redact(step.name),
        status: step.status,
        durationMs: step.durationMs,
        exitCode: step.exitCode,
        startedAt: step.startedAt,
        finishedAt: step.finishedAt,
        error: step.error ? redact(step.error) : undefined,
        outputs: sanitizeValue(step.outputs || {}, redact) as Record<string, any>,
        logContent:
          !canViewLogs || step.status === 'running' || step.status === 'pending'
            ? ''
            : redact(savedLog || step.logContent || ''),
      };
    }),
    artifacts: (report.artifacts || []).map(redact),
    canViewLogs,
  };
}

export function renderRunHtml(report: RunView): string {
  return runTemplate.replace('__REPORT_STATE__', () => serializeHtmlState({ report }));
}

function buildPendingReport(job: JobRecord & Record<string, any>, payload: JobPayload, steps: WorkflowStep[]): WorkflowExecutionReport {
  const startedAt = job.started_at || job.created_at;

  return {
    jobId: String(job.id),
    parentId: String(job.parentId || ''),
    workflowName: job.workflow_id,
    status: job.status,
    durationMs: job.status === 'running' ? Math.max(0, Date.now() - Date.parse(startedAt)) : 0,
    startedAt,
    inputs: payload.inputs || {},
    environment: {},
    steps: steps.map((step, index) => ({
      id: step.id || `step-${index}`,
      name: step.name || step.id || `step-${index}`,
      status: 'pending',
      durationMs: 0,
      outputs: {},
      logContent: '',
    })),
    artifacts: [],
    rerunToken: '',
  };
}

function sanitizeValue(value: unknown, redact: (value: string) => string): unknown {
  if (typeof value === 'string') return redact(value);
  if (Array.isArray(value)) return value.map((entry) => sanitizeValue(entry, redact));
  if (!value || typeof value !== 'object') return value;

  return Object.fromEntries(
    Object.entries(value)
      .filter(([key]) => key.toLowerCase() !== 'raw' && !SENSITIVE_KEY.test(key))
      .map(([key, entry]) => [key, sanitizeValue(entry, redact)]),
  );
}
