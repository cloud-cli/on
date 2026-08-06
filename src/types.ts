import { Readable } from 'node:stream';

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
}