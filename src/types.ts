import { QueueManager } from './queue.js';
import { SecretStore } from './secrets.js';

export interface StepContext {
  jobId: string;
  stepId: string;
  workspacePath: string;
  command: string;
  env?: Record<string, string>;
  image?: string; // Optional: Docker container image
  timeoutMs?: number;
}

export interface StepResult {
  exitCode: number;
  durationMs: number;
  error?: Error;
}

export interface StepExecutionHandle {
  /**
   * Promise that resolves when step completes or fails
   */
  done: Promise<StepResult>;

  /**
   * Safely kills the step process tree
   */
  cancel(): Promise<void>;

  /**
   * Path to where logs are being written on disk
   */
  logFilePath: string;
}

export interface ExecutionDriver {
  name: string;

  /**
   * Validates if host can run this driver (e.g., systemd is present)
   */
  isSupported(): Promise<boolean>;

  /**
   * Executes a step context
   */
  execute(ctx: StepContext): Promise<StepExecutionHandle>;

  readLog(file: string): Promise<string>;
}

export interface PreprocessedWebhook {
  isValid: boolean;
  inputs: Record<string, any>;
}

export interface WebhookPreprocessor {
  name: string;
  parse(headers: Record<string, string>, rawBodyBuffer: Buffer, secret?: string): PreprocessedWebhook;
}

export interface WorkflowStep {
  id?: string;
  name?: string;
  run?: string;
  eval?: string;
  dispatch?: string;
  image?: string;
  timeoutMs?: number;
  env?: Record<string, string>;
}

export interface WorkflowDefinition {
  id: string;
  name: string;
  on: {
    provider: string; // 'github', 'generic', etc.
    if?: string | string[]; // Expression: "inputs.event == 'push' && inputs.branch == 'main'"
  };
  concurrency?: {
    group: string;
    cancelInProgress?: boolean;
  };
  steps: WorkflowStep[];
  env?: Record<string, string>;
}

export interface WebhookServerOptions {
  config: RunnerConfig;
  queue: QueueManager;
  secrets: SecretStore;
  adminToken: string;
}

export type JobStatus = 'pending' | 'running' | 'success' | 'failed' | 'cancelling' | 'cancelled';

export interface JobRecord {
  id: number;
  workflow_id: string;
  concurrency_key: string | null;
  status: JobStatus;
  worker_id: string | null;
  payload: string; // JSON string of the Job Context/Steps
  created_at: string;
}

export type WorkflowInputs = Record<string, any>;

export interface JobPayload {
  workflowId: string;
  steps: WorkflowStep[];
  inputs: WorkflowInputs;
  env?: Record<string, string>;
}

export interface MatrixStrategy {
  matrix?: Record<string, (string | number | boolean)[]>;
  'max-parallel'?: number;
}

export interface ParsedWorkflow {
  id?: string;
  name: string;
  strategy?: MatrixStrategy;
  env?: Record<string, string>;
  steps: WorkflowStep[];
  [key: string]: any;
}

export interface IngressContext {
  provider: string;
  headers: Record<string, string>;
  body: any;
  rawBuffer: Buffer;
}

export interface WorkflowContext {
  jobId: string;
  workflowName: string;
  inputs: WorkflowInputs;
  env: Record<string, string>;
}

export interface WorkflowPlugin {
  name: string;

  // -------------------------------------------------------------
  // INGRESS HOOKS (HTTP Server Side)
  // -------------------------------------------------------------
  /** Verify HMAC or signatures */
  onAuthenticate?: (ctx: IngressContext) => Promise<boolean> | boolean;

  /** Convert raw body/headers into normalized inputs */
  onTransform?: (ctx: IngressContext) => Promise<Record<string, any>> | Record<string, any>;

  /** Final gatekeeper check (return false to drop job before enqueueing) */
  onFilter?: (inputs: Record<string, any>, ctx: IngressContext) => Promise<boolean> | boolean;

  // -------------------------------------------------------------
  // EXECUTION HOOKS (Worker / Runner Side)
  // -------------------------------------------------------------
  /** Runs before any steps execute (e.g. notify Slack, update GitHub status to "Pending") */
  onWorkflowStart?: (wf: WorkflowContext) => Promise<void>;

  /** Runs right before a step executes (e.g. inject dynamic secrets, prepare workspace) */
  onStepBefore?: (step: StepContext, wf: WorkflowContext) => Promise<void>;

  /** Runs after a step finishes (e.g. parse outputs, stream step metrics) */
  onStepAfter?: (step: StepContext, result: StepResult, wf: WorkflowContext) => Promise<void>;

  /** Runs when workflow succeeds or fails (e.g. update GitHub status to "Success/Failure", wipe layers) */
  onWorkflowFinish?: (wf: WorkflowContext, status: 'success' | 'failed', error?: Error) => Promise<void>;
}

export interface StepReport {
  id: string;
  name: string;
  status: 'success' | 'failed' | 'skipped' | 'cancelled';
  durationMs: number;
  exitCode: number;
  error?: string;
  outputs: Record<string, any>;
  logContent: string;
}

export interface WorkflowExecutionReport {
  jobId: string;
  workflowName: string;
  status: 'success' | 'failed' | 'cancelled';
  durationMs: number;
  startedAt: string;
  finishedAt: string;
  inputs: Record<string, any>; // Sanitized trigger inputs
  environment: Record<string, string>; // Exported workflow environment
  steps: StepReport[];
  artifacts: string[]; // List of generated artifact paths
  rerunToken: string; // Opaque token/state snapshot to re-run
}

export interface Reporter {
  name: string;
  report(execReport: WorkflowExecutionReport): Promise<void>;
}

export interface RunnerConfig {
  /** Ingress HTTP Gateway Port */
  port: number;
  /** Admin Secret for API / webhook operations */
  adminToken: string;
  /** SQLite Database connection URL / path */
  database: string;
  /** Directory where workflow YAML files live */
  workflows: string;
  /** Number of concurrent worker loops to spawn */
  workers: number;
  /** Storage path for job workspaces and step logs */
  storagePath: string;
  /** Global environment variables injected into all step runs */
  env: Record<string, string>;
  /** Registered reporter plugins (JSON, Slack, HTML, etc.) */
  reporters: Reporter[];
}

export type UserRunnerConfig = Partial<RunnerConfig>;
