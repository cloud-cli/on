export interface StepReport {
  id: string;
  name: string;
  status: 'success' | 'failed' | 'skipped' | 'cancelled';
  durationMs: number;
  exitCode: number;
  error?: string;
  outputs: Record<string, any>;
  logFilePath: string;
}

export interface WorkflowExecutionReport {
  jobId: string;
  workflowName: string;
  status: 'success' | 'failed' | 'cancelled';
  durationMs: number;
  startedAt: string;
  finishedAt: string;
  inputs: Record<string, any>;        // Sanitized trigger inputs
  environment: Record<string, string>; // Exported workflow environment
  steps: StepReport[];
  artifacts: string[];                 // List of generated artifact paths
  rerunToken: string;                 // Opaque token/state snapshot to re-run
}

export interface Reporter {
  name: string;
  report(execReport: WorkflowExecutionReport): Promise<void>;
}