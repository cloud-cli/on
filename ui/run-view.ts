import runTemplate from "./run.html?raw";
export { runTemplate };
import type { JobPayload, JobRecord, StepReport, WorkflowExecutionReport, WorkflowStep } from "../src/types.js";

const SENSITIVE_KEY =
  /(?:^|[_-])auth(?:entication)?(?:$|[_-])|access[_-]?key|api[_-]?key|authorization|cookie|credential|passphrase|password|private[_-]?key|secret|session(?:id)?|signing[_-]?key|token/i;

function normalizeTimestamp(value: string): string {
  const text = String(value || "").trim();
  if (!text) {
    return text;
  }
  const normalized = text.includes("T") ? text : text.replace(" ", "T");
  return /(?:Z|[+-]\d{2}:?\d{2})$/i.test(normalized) ? normalized : `${normalized}Z`;
}

export interface RunView {
  jobId: string;
  workerId?: string;
  workerName?: string;
  workflowId: string;
  workflowRevision: number;
  workflowSourceYaml?: string;
  parentId: string;
  workflowName: string;
  status: WorkflowExecutionReport["status"];
  durationMs: number;
  startedAt: string;
  finishedAt?: string;
  inputs: Record<string, unknown>;
  steps: StepReport[];
  artifacts: string[];
  canViewLogs: boolean;
  canViewInputs: boolean;
  canViewArtifacts: boolean;
  canControl: boolean;
  canEditWorkflow: boolean;
}

export type RunViewAccess = {
  logs: boolean;
  inputs: boolean;
  artifacts: boolean;
  control: boolean;
  editWorkflow: boolean;
};

export function buildRunView(
  job: JobRecord & Record<string, any>,
  logs: Record<string, string>,
  redact: (value: string) => string,
  steps: WorkflowStep[] = [],
  canViewLogsArg = true,
  workflowSourceYaml?: string,
  canonicalWorkflowName?: string,
  access?: Partial<RunViewAccess>,
): RunView {
  const canViewLogs = access?.logs ?? canViewLogsArg;
  const canViewInputs = access?.inputs ?? canViewLogs;
  const canViewArtifacts = access?.artifacts ?? canViewLogs;
  const payload = JSON.parse(job.payload) as JobPayload;
  const report = job.report
    ? (JSON.parse(job.report) as WorkflowExecutionReport)
    : buildPendingReport(job, payload, steps);
  const status = job.status;

  return {
    jobId: String(job.id),
    workerId: job.worker_id || undefined,
    workflowId: job.workflow_id,
    workflowRevision: Number(job.workflow_revision),
    workflowSourceYaml: canViewLogs ? workflowSourceYaml : undefined,
    parentId: String(report.parentId || job.parentId || ""),
    workflowName: redact(canonicalWorkflowName || report.workflowName || "Unknown workflow"),
    status,
    durationMs:
      status === "running"
        ? Math.max(0, Date.now() - Date.parse(normalizeTimestamp(report.startedAt)))
        : report.durationMs,
    startedAt: normalizeTimestamp(report.startedAt),
    finishedAt: report.finishedAt,
    inputs: canViewInputs ? (sanitizeValue(report.inputs || {}, redact) as Record<string, unknown>) : {},
    steps: (report.steps || []).map((step) => {
      const savedLog = Object.hasOwn(logs, step.id) && typeof logs[step.id] === "string" ? logs[step.id] : "";
      return {
        id: step.id,
        name: redact(step.name),
        status: step.status,
        durationMs: step.durationMs,
        exitCode: step.exitCode,
        startedAt: step.startedAt,
        finishedAt: step.finishedAt,
        error: canViewLogs && step.error ? redact(step.error) : undefined,
        outputs: canViewLogs ? (sanitizeValue(step.outputs || {}, redact) as Record<string, any>) : {},
        logContent:
          !canViewLogs || step.status === "running" || step.status === "pending"
            ? ""
            : redact(savedLog || step.logContent || ""),
      };
    }),
    artifacts: canViewArtifacts ? (report.artifacts || []).map(redact) : [],
    canViewLogs,
    canViewInputs,
    canViewArtifacts,
    canControl: access?.control ?? canViewLogs,
    canEditWorkflow: access?.editWorkflow ?? canViewLogs,
  };
}

export function renderRunHtml(report: RunView): string {
  return runTemplate;
}

function buildPendingReport(
  job: JobRecord & Record<string, any>,
  payload: JobPayload,
  steps: WorkflowStep[],
): WorkflowExecutionReport {
  const startedAt = normalizeTimestamp(job.started_at || job.created_at);

  return {
    jobId: String(job.id),
    parentId: String(job.parentId || ""),
    workflowName: job.workflow_id,
    status: job.status,
    durationMs: job.status === "running" ? Math.max(0, Date.now() - Date.parse(startedAt)) : 0,
    startedAt,
    inputs: payload.inputs || {},
    environment: {},
    steps: steps.map((step, index) => ({
      id: step.id || `step-${index}`,
      name: step.name || step.id || `step-${index}`,
      status: "pending",
      durationMs: 0,
      outputs: {},
      logContent: "",
    })),
    artifacts: [],
    rerunToken: "",
  };
}

function sanitizeValue(value: unknown, redact: (value: string) => string): unknown {
  if (typeof value === "string") {
    return redact(value);
  }
  if (Array.isArray(value)) {
    return value.map((entry) => sanitizeValue(entry, redact));
  }
  if (!value || typeof value !== "object") {
    return value;
  }

  return Object.fromEntries(
    Object.entries(value)
      .filter(([key]) => !SENSITIVE_KEY.test(key))
      .map(([key, entry]) => [key, sanitizeValue(entry, redact)]),
  );
}
