import { QueueManager } from './queue.js';
import { SecretStore } from './secrets.js';

// types can be grouped in 4 different layers
// 1. configuration and initialization: the settings to initialize the webserver and the runners, and bridge the host with the runnables
// 2. workflow definitions: the templates that will generate actionable jobs, and need the layer 1 to be properly configured
// 3. workflow queue and pending jobs: a combination of templates and inputs that generate multiple steps to execute, which depend upon layer 2
// 4. a single unit of work: an executable step, belonging to a job, which is atomic and depends upon information in the other 3 layers

export interface RunnerConfig {
  /** Ingress HTTP Gateway Port */
  port: number;
  /** Admin Secret for API / webhook operations */
  adminToken: string;
  /** SQLite Database connection URL / path */
  database: string;
  /** Maximum number of jobs executed concurrently on this node */
  workers: number;
  /** Webhook server URL used for worker event notifications */
  serverUrl: string;
  /** Capabilities advertised by this worker node */
  tags: string[];
  /** Storage path for job workspaces and step logs */
  storagePath: string;
  /** Global environment variables injected into all step runs */
  env: Record<string, string>;
  /** External integrations notified about workflow lifecycle changes */
  plugins: WorkflowPlugin[];
}

export type UserRunnerConfig = Partial<RunnerConfig>;

export interface StepContext {
  jobId: string;
  step: WorkflowStep;
  logsDir: string;
  workingDir: string;
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
  execute(ctx: StepContext): StepExecutionHandle;

  readLog(file: string): Promise<string>;
}

export interface PreprocessedWebhook {
  isValid: boolean;
  inputs: Record<string, any>;
}

export interface WebhookPreprocessor {
  name: string;
  parse(headers: Record<string, string>, rawBodyBuffer: Buffer, secret?: string): PreprocessedWebhook;
  filter?(inputs: Record<string, any>, trigger: WorkflowTrigger): PreprocessedWebhook;
}

export interface WorkflowTrigger {
  provider: string; // 'github', 'generic', etc.
  if?: string | string[];
  events?: string[];
  owner?: string | string[];
  repo?: string | string[];
  branches?: string[];
  tag?: boolean;
  tags?: string[];
  paths?: string[];
}

export interface ScheduleTrigger {
  id?: string;
  cron?: string;
  event?: 'sunrise' | 'sunset';
  latitude?: number;
  longitude?: number;
  timezone?: string;
  offset?: string;
}

export interface WorkflowStep {
  id?: string;
  if?: string;
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
  on: WorkflowTrigger;
  concurrency?: {
    group: string;
    cancelInProgress?: boolean;
  };
  steps: WorkflowStep[];
  env?: Record<string, string>;
  /** Worker capabilities required to execute this workflow */
  tags?: string[];
  /** Time triggers stored alongside webhook triggers in DB-authored workflows. */
  schedule?: ScheduleTrigger[];
  solar?: ScheduleTrigger[];
}

export interface WorkflowRevision {
  workflowId: string;
  revision: number;
  definition: WorkflowDefinition;
}

export interface WebhookServerOptions {
  config: RunnerConfig;
  queue: QueueManager;
  secrets: SecretStore;
  adminToken: string;
}

export type JobStatus = 'pending' | 'running' | 'success' | 'failed' | 'cancelled';

export interface JobRecord {
  id: number;
  parentId?: number;
  workflow_id: string;
  workflow_revision: number;
  required_tags: string;
  concurrency_key: string | null;
  status: JobStatus;
  worker_id: string | null;
  payload: string; // JSON string of dynamic trigger inputs only
  created_at: string;
}

export type WorkflowInputs = Record<string, any>;

export interface JobPayload {
  inputs: WorkflowInputs;
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

export interface WorkflowContext {
  jobId: string;
  workflowName: string;
  inputs: WorkflowInputs;
  runUrl: string;
}

export interface WorkflowPlugin {
  name: string;
  onWorkflowStart?: (wf: WorkflowContext) => Promise<void>;
  onWorkflowFinish?: (wf: WorkflowContext, status: FinalJobStatus) => Promise<void>;
}

export type FinalJobStatus = Exclude<JobStatus, 'pending' | 'running'>;

export interface StepReport {
  id: string;
  name: string;
  status: 'pending' | 'running' | 'success' | 'failed' | 'skipped' | 'cancelled';
  durationMs: number;
  exitCode?: number;
  startedAt?: string;
  finishedAt?: string;
  error?: string;
  outputs: Record<string, any>;
  logContent: string;
}

export interface WorkflowExecutionReport {
  jobId: string;
  parentId: string;
  workflowName: string;
  status: 'pending' | 'running' | 'success' | 'failed' | 'cancelled';
  durationMs: number;
  startedAt: string;
  finishedAt?: string;
  inputs: Record<string, any>; // Sanitized trigger inputs
  environment: Record<string, string>; // Exported workflow environment
  steps: StepReport[];
  artifacts: string[]; // List of generated artifact paths
  rerunToken: string; // Opaque token/state snapshot to re-run
}

export interface Processable {
  workerId: string;
  job: JobRecord;
  queue: QueueManager;
  secrets: SecretStore;
  config: RunnerConfig;
  driver: ExecutionDriver;
  workflow?: WorkflowDefinition;
}

export interface ContextualizedProcessable extends Processable {
  payload: JobPayload;
  steps: WorkflowStep[];
  executionContext: JobExecutionContext;
}

export interface JobExecutionContext {
  inputs: any;
  env: Record<string, string>;
  secrets: Record<string, string>;
  steps: Record<string, { status: string; exitCode: number; outputs: any }>;
  workingDir: string;
  logsDir: string;
  files: {
    exists(path: string): boolean;
    readFile(path: string): string;
    join(...paths: string[]): string;
  };
}
