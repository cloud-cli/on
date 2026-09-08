import FS from 'node:fs';
import Path from 'node:path';
import { resolveDriver } from './drivers/index.js';
import { QueueManager } from './queue.js';
import { SafeExpressionEvaluator, workspaceFiles } from './safe-eval.js';
import { SecretStore } from './secrets.js';
import {
  ExecutionDriver,
  JobPayload,
  RunnerConfig,
  StepContext,
  StepExecutionHandle,
  StepReport,
  StepResult,
  WorkflowExecutionReport,
  WorkflowStep,
  Processable,
  ContextualizedProcessable,
  JobExecutionContext,
  JobRecord,
  FinalJobStatus,
} from './types.js';
import { setupSignalHandlers } from './signals.js';
import { consumeRunnerEvents } from './events.js';
import { PluginManager } from './plugins/manager.js';
import { DEFAULT_STEP_TIMEOUT_MS, WorkflowRepository } from './workflows.js';
import { debug } from './debug.js';
import { expandMatrix } from './parser/matrix-expander.js';

export const shutdownState = {
  isStopping: false,
};

const activeStepHandles = new Set<{ cancel: () => Promise<void> }>();
let eventStreamController: AbortController | null = null;
let wakeScheduler: (() => void) | null = null;

/**
 * Called by signal handlers in index.ts during graceful shutdown
 */
export async function abortActiveWorkerTask() {
  if (!activeStepHandles.size) return;
  console.log('⚡ Cancelling active step execution handles due to worker shutdown...');
  await Promise.allSettled(Array.from(activeStepHandles, (handle) => handle.cancel()));
  activeStepHandles.clear();
}

export function requestWorkerShutdown() {
  shutdownState.isStopping = true;
  eventStreamController?.abort();
  wakeScheduler?.();
}

/**
 * Spawns worker loops as requested by configuration
 */
export function startWorkers(count: number, queue: QueueManager, secrets: SecretStore, config: RunnerConfig) {
  shutdownState.isStopping = false;
  const workerPromises = [startWorkerScheduler(count, queue, secrets, config)];
  setupSignalHandlers(workerPromises);
  return workerPromises;
}

/**
 * Event-driven worker scheduler with bounded local concurrency.
 */
export async function startWorkerScheduler(
  concurrency: number,
  queue: QueueManager,
  secrets: SecretStore,
  config: RunnerConfig,
) {
  const driver = await resolveDriver();
  const workflows = new WorkflowRepository();
  const activeJobs = new Set<Promise<void>>();
  let wakeVersion = 0;
  let pendingWake: (() => void) | null = null;
  const wake = () => {
    wakeVersion++;
    pendingWake?.();
  };

  wakeScheduler = wake;
  eventStreamController = new AbortController();
  const eventStream = maintainEventStream(config, eventStreamController.signal, wake);
  console.log(
    `🚀 Worker scheduler started. Driver: ${driver.name}. Concurrency: ${concurrency}. Tags: ${config.tags.join(', ') || '(none)'}`,
  );

  while (!shutdownState.isStopping) {
    const observedWake = wakeVersion;

    try {
      while (activeJobs.size < concurrency && !shutdownState.isStopping) {
        const job = await queue.claimNextJob(config.tags);
        if (!job) break;
        if (shutdownState.isStopping) {
          await queue.releaseJob(job.id);
          break;
        }

        // Match the ID written by QueueManager.claimNextJob so the server can
        // authorize this machine's request for the claimed job's secrets.
        const workerId = process.env.WORKER_NAME || 'cli';
        let task: Promise<void>;
        task = (async () => {
          void notifyJobChange(config, job.id);
          const workflow = await workflows.getRevision(job.workflow_id, job.workflow_revision);
          if (!workflow) {
            await queue.finishJob(job.id, 'failed');
            throw new Error(`Workflow ${job.workflow_id} revision ${job.workflow_revision} was not found`);
          }
          const jobSecrets = new SecretStore();
          jobSecrets.replace(await fetchJobSecrets(config, workerId, job.id));
          await processJob({ workerId, job, queue, secrets: jobSecrets, config, driver, workflow });
        })()
          .catch((error) => console.error(`[${workerId}] ⚠️ Worker execution error:`, error))
          .finally(() => {
            activeJobs.delete(task);
            void notifyJobChange(config, job.id);
            wake();
          });
        activeJobs.add(task);
      }
    } catch (error) {
      console.error('⚠️ Worker scheduler claim error:', error);
      setTimeout(wake, 5000).unref();
    }

    if (!shutdownState.isStopping && wakeVersion === observedWake) {
      await waitForWake(
        observedWake,
        () => wakeVersion,
        (resolve) => (pendingWake = resolve),
      );
      pendingWake = null;
    }
  }

  eventStreamController.abort();
  await Promise.allSettled(activeJobs);
  await eventStream;
  wakeScheduler = null;
  console.log('🛑 Worker scheduler stopped cleanly.');
}

async function maintainEventStream(config: RunnerConfig, signal: AbortSignal, wake: () => void): Promise<void> {
  let retryMs = 1000;

  while (!signal.aborted) {
    try {
      await consumeRunnerEvents(
        config.serverUrl,
        signal,
        (event, data) => {
          if (event !== 'jobs.available') return;
          const requiredTags = Array.isArray(data.tags)
            ? data.tags.filter((tag): tag is string => typeof tag === 'string')
            : [];
          if (requiredTags.every((tag) => config.tags.includes(tag))) wake();
        },
        wake,
      );
      retryMs = 1000;
    } catch (error: any) {
      if (signal.aborted || error?.name === 'AbortError') break;
      console.error(`⚠️ Worker event stream disconnected: ${error.message}`);
    }

    await abortableDelay(retryMs, signal);
    retryMs = Math.min(retryMs * 2, 30_000);
  }
}

function waitForWake(
  observedWake: number,
  getWakeVersion: () => number,
  setWake: (resolve: () => void) => void,
): Promise<void> {
  return new Promise((resolve) => {
    if (getWakeVersion() !== observedWake) return resolve();

    const timer = setTimeout(resolve, 60_000);
    setWake(() => {
      clearTimeout(timer);
      resolve();
    });
  });
}

function abortableDelay(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (signal.aborted) return resolve();
    const onAbort = () => {
      clearTimeout(timer);
      resolve();
    };
    const timer = setTimeout(() => {
      signal.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    signal.addEventListener('abort', onAbort, { once: true });
  });
}

async function notifyJobChange(config: RunnerConfig, jobId: string | number): Promise<void> {
  if (!config.workerToken) return;

  try {
    const response = await fetch(new URL('/api/events', config.serverUrl), {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${config.workerToken}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ jobId }),
      signal: AbortSignal.timeout(5000),
    });
    if (!response.ok) debug(`Failed to publish job status event: HTTP ${response.status}`);
  } catch (error) {
    debug('Failed to publish job status event:', error);
  }
}

async function fetchJobSecrets(
  config: RunnerConfig,
  workerId: string,
  jobId: string | number,
): Promise<Record<string, string>> {
  if (!config.workerToken) return {};
  try {
    const response = await fetch(new URL(`/api/jobs/${jobId}/secrets`, config.serverUrl), {
      headers: { Authorization: `Bearer ${config.workerToken}`, 'X-Runner-Worker-Id': workerId },
      signal: AbortSignal.timeout(5000),
    });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    return (await response.json()).secrets || {};
  } catch (error) {
    console.error(`Unable to retrieve secrets for job ${jobId}:`, error);
    throw error;
  }
}

/**
 * Processes a single job sequentially
 */
export async function processJob(p: Processable) {
  const { workerId, job, config, secrets, queue } = p;
  console.log(`\n[${workerId}] 📦 Claimed Job #${job.id} (Workflow: ${job.workflow_id})`);

  const payload = (typeof job.payload === 'string' ? JSON.parse(job.payload) : job.payload) as JobPayload;
  if (!p.workflow) throw new Error(`Workflow ${job.workflow_id} revision ${job.workflow_revision} was not resolved`);
  const candidateWorkflow = payload.matrix
    ? expandMatrix(p.workflow).find((variant) => JSON.stringify(variant.matrixContext) === JSON.stringify(payload.matrix))
    : p.workflow;
  if (!candidateWorkflow) throw new Error(`Matrix variant for job ${job.id} was not found`);
  const resolvedWorkflow = candidateWorkflow as typeof p.workflow;
  const processable = { ...p, workflow: resolvedWorkflow };
  const steps = resolvedWorkflow.steps;
  const inputs = payload.inputs || {};
  const jobStartTime = Date.now();
  const storagePath = Path.join(config.storagePath, `job-${job.id}`);
  const logsDir = Path.join(storagePath, 'logs');
  const workingDir = Path.join(storagePath, 'wd');

  // Step Execution Context available in expressions: ${steps.step1.outputs.id}
  const executionContext: JobExecutionContext = {
    inputs,
    env: { ...config.env },
    secrets: secrets.getAll(),
    steps: {},
    logsDir,
    workingDir,
    files: workspaceFiles(workingDir),
  };
  let cacheKey = '';

  const stepReports = steps.map((step, index): StepReport => {
    step.id ||= `step-${index}`;
    step.name ||= step.id;

    return {
      id: step.id,
      name: step.name,
      status: 'pending',
      durationMs: 0,
      outputs: {},
      logContent: '',
    };
  });
  const executionReport = buildExecutionReport(
    job,
    'running',
    jobStartTime,
    inputs,
    executionContext.env,
    stepReports,
    payload,
  );

  // Make the trace available before the first step starts.
  await queue.saveReport(job.id, executionReport);
  void notifyJobChange(config, job.id);
  try {
    Object.assign(executionContext.env, await evaluateEnv(resolvedWorkflow.env, executionContext));
    writeSecretFiles(resolvedWorkflow.secretFiles, secrets.getAll(), workingDir);
    cacheKey = resolvedWorkflow.cache
      ? String(await SafeExpressionEvaluator.evaluateValue(resolvedWorkflow.cache.key, executionContext))
      : '';
    if (cacheKey && resolvedWorkflow.cache) await restoreStoredFiles(queue, 'cache', `${job.workflow_id}:${cacheKey}`, resolvedWorkflow.cache.paths, workingDir);
    await queue.saveReport(job.id, executionReport);
  } catch (error: any) {
    executionReport.status = 'failed';
    executionReport.finishedAt = new Date().toISOString();
    executionReport.durationMs = Date.now() - jobStartTime;
    const failedReport = { ...executionReport, steps: executionReport.steps.map((step) => ({ ...step, status: 'skipped' as const })) };
    await queue.completeJob(job.id, 'failed', failedReport);
    console.error(`[${workerId}] ❌ Job setup failed:`, error);
    return;
  }
  const pluginManager = new PluginManager(config.plugins);
  const workflowContext = {
    jobId: String(job.id),
    workflowName: resolvedWorkflow.name,
    inputs,
    runUrl: new URL(`/runs/${job.id}`, config.serverUrl).toString(),
  };
  await pluginManager.triggerWorkflowStart(workflowContext);

  const context = { payload, steps, executionContext, ...processable };
  const { cancelled, failed } = await processSteps(context, executionReport);
  let finalStatus: FinalJobStatus = cancelled ? 'cancelled' : failed ? 'failed' : 'success';
  if (finalStatus === 'success') {
    try {
      const artifacts = resolvedWorkflow.artifacts
        ? await collectStoredFiles(resolvedWorkflow.artifacts.paths, workingDir)
        : [];
      if (artifacts.length) {
        await queue.saveStoredFiles('artifact', String(job.id), artifacts);
        executionReport.artifacts = artifacts.map((file) => file.path);
      }
      if (cacheKey && resolvedWorkflow.cache) {
        const cacheFiles = await collectStoredFiles(resolvedWorkflow.cache.paths, workingDir);
        if (cacheFiles.length) await queue.saveStoredFiles('cache', `${job.workflow_id}:${cacheKey}`, cacheFiles);
      }
    } catch (error: any) {
      console.error(`[${workerId}] ⚠️ Failed to store workflow files:`, error);
      finalStatus = 'failed';
    }
  }

  executionReport.status = finalStatus;
  executionReport.durationMs = Date.now() - jobStartTime;
  executionReport.finishedAt = new Date().toISOString();
  await queue.completeJob(job.id, finalStatus, executionReport);
  void notifyJobChange(config, job.id);
  console.log(`[${workerId}] ✅ Job #${job.id} completed as: ${finalStatus}`);
  await pluginManager.triggerWorkflowFinish(workflowContext, finalStatus);
}

interface ExecOutput {
  failed: boolean;
  skipped: boolean;
  cancelled: boolean;
  report: StepReport | null;
}

interface ProcessStepsOutput {
  failed: boolean;
  cancelled: boolean;
  stepReports: StepReport[];
}

async function processSteps(
  p: ContextualizedProcessable,
  executionReport: WorkflowExecutionReport,
): Promise<ProcessStepsOutput> {
  const { driver, workerId, queue, config, job, payload, steps, executionContext } = p;
  const stepReports = executionReport.steps;
  let failed = false;
  let cancelled = false;
  let processedSteps = 0;

  try {
    for (let i = 0; i < steps.length; i++) {
      const step = steps[i];
      const stepStartedAt = new Date().toISOString();
      stepReports[i] = {
        ...stepReports[i],
        status: 'running',
        durationMs: 0,
        exitCode: undefined,
        error: undefined,
        outputs: {},
        logContent: '',
        startedAt: stepStartedAt,
        finishedAt: undefined,
      };
      executionReport.durationMs = Date.now() - Date.parse(executionReport.startedAt);
      await queue.saveReport(job.id, executionReport);
      void notifyJobChange(config, job.id);

      let stepResult: ExecOutput = {
        failed: true,
        skipped: false,
        cancelled: false,
        report: null,
      };
      const retries = p.workflow?.retries ?? 0;
      for (let attempt = 1; attempt <= retries + 1; attempt++) {
        stepResult = await executeSingleStep({
          workerId,
          jobId: job.id,
          step,
          stepIndex: i,
          attempt,
          executionContext,
          driver,
          queue,
          config,
        });
        if (!stepResult.failed || stepResult.cancelled || attempt > retries) break;
        console.log(`[${workerId}] 🔁 Retrying step [${step.id}] (${attempt}/${retries + 1})`);
      }

      if (stepResult.report) {
        stepReports[i] = {
          ...stepResult.report,
          startedAt: stepStartedAt,
          finishedAt: new Date().toISOString(),
        };
      } else if (stepResult.skipped) {
        stepReports[i] = {
          ...stepReports[i],
          status: 'skipped',
          durationMs: 0,
          exitCode: 0,
          finishedAt: new Date().toISOString(),
        };
      } else {
        stepReports[i] = {
          ...stepReports[i],
          status: 'failed',
          durationMs: 0,
          exitCode: 1,
          error: 'Step failed before execution started',
          finishedAt: new Date().toISOString(),
        };
      }
      processedSteps = i + 1;
      executionReport.durationMs = Date.now() - Date.parse(executionReport.startedAt);
      await queue.saveReport(job.id, executionReport);
      void notifyJobChange(config, job.id);

      if (stepResult.skipped) {
        break;
      }

      if (stepResult.cancelled) {
        cancelled = true;
        failed = true;
        break;
      }

      if (stepResult.failed) {
        failed = true;
        break;
      }
    }
  } catch (e) {
    console.log('🛑 Step failed', e);
    failed = true;
  }

  // Mark unexecuted steps as skipped
  if (processedSteps < steps.length) {
    fillSkippedSteps(steps, processedSteps, stepReports);
    executionReport.durationMs = Date.now() - Date.parse(executionReport.startedAt);
    await queue.saveReport(job.id, executionReport);
    void notifyJobChange(config, job.id);
  }

  return { failed, cancelled, stepReports };
}

/**
 * Step Dispatcher: Routes to either `eval:` or `run:` execution
 */
async function executeSingleStep(params: {
  workerId: string;
  jobId: string | number;
  step: WorkflowStep;
  stepIndex: number;
  attempt: number;
  executionContext: JobExecutionContext;
  driver: ExecutionDriver;
  queue: QueueManager;
  config: RunnerConfig;
}): Promise<ExecOutput> {
  const { step, stepIndex, executionContext } = params;
  step.id ||= `step-${stepIndex}`;
  step.name ||= step.id;

  if (step.if) {
    const shouldRun = await SafeExpressionEvaluator.evaluateConditions(step.if, executionContext);

    if (!shouldRun) {
      debug(`⏩ Skipped step ${step.id} based on condition: ${step.if}`, executionContext);

      return {
        failed: false,
        cancelled: false,
        skipped: true,
        report: null,
      };
    }
  }

  try {
    const evaluatedStepEnv = await evaluateEnv(step.env, executionContext);
    const stepContext: StepContext = {
      jobId: String(params.jobId),
      step,
      command: step.run!,
      timeoutMs: step.timeoutMs ?? DEFAULT_STEP_TIMEOUT_MS,
      attempt: params.attempt,
      image: step.image,
      volumes: step.volumes,
      dockerArgs: step.dockerArgs,
      workingDir: executionContext.workingDir,
      logsDir: executionContext.logsDir,
      env: {
        ...executionContext.env,
        ...evaluatedStepEnv,
        WORKING_DIR: executionContext.workingDir,
      },
    };

    if (step.eval) {
      return executeEvalStep({ ...params, stepContext });
    } else {
      return executeRunStep({ ...params, stepContext });
    }
  } catch (e: any) {
    const errorMessage = e?.message || String(e);
    await params.queue.saveStepLog(params.jobId, step.id!, `[STEP ERROR]:\n${errorMessage}`);
    debug(`⏩ Failed to run step ${step.id}`, executionContext, e);

    return {
      failed: true,
      cancelled: false,
      skipped: false,
      report: {
        id: step.id!,
        name: step.name!,
        status: 'failed',
        durationMs: 0,
        exitCode: 1,
        error: errorMessage,
        outputs: {},
        logContent: '',
      },
    };
  }
}

/**
 * In-Process JS `eval:` Step Execution
 */
async function executeEvalStep(params: {
  queue: QueueManager;
  stepContext: StepContext;
  executionContext: JobExecutionContext;
}): Promise<ExecOutput> {
  const { queue, stepContext, executionContext } = params;
  const { jobId, step } = stepContext;
  const startTime = Date.now();
  const stepId = step.id!;
  const stepName = step.name!;
  let timeoutTimer: NodeJS.Timeout | undefined;

  try {
    const timeout = new Promise<never>((_, reject) => {
      timeoutTimer = setTimeout(() => reject(new Error(`Step timed out after ${stepContext.timeoutMs}ms`)), stepContext.timeoutMs);
      timeoutTimer.unref();
    });
    const evalResult = await Promise.race([
      SafeExpressionEvaluator.evaluateExpression(step.eval!, executionContext),
      timeout,
    ]);

    // Store outputs in execution context for downstream steps
    executionContext.steps[stepId] = {
      status: 'success',
      exitCode: 0,
      outputs: evalResult ?? {},
    };

    // Save evaluation result log to step_logs table
    const logText = typeof evalResult === 'object' ? JSON.stringify(evalResult, null, 2) : String(evalResult ?? 'OK');
    await queue.saveStepLog(jobId, stepId, `[JS EVAL OUTPUT]:\n${logText}`);

    console.log(`[${stepId}] ✅ JS Eval step complete.`);

    return {
      failed: false,
      cancelled: false,
      skipped: false,
      report: {
        id: stepId,
        name: stepName,
        status: 'success' as const,
        durationMs: Date.now() - startTime,
        exitCode: 0,
        outputs: executionContext.steps[stepId].outputs,
        logContent: '',
      },
    };
  } catch (err: any) {
    console.error(`[${stepId}] ❌ JS Eval step failed:`, err);

    executionContext.steps[stepId] = {
      status: 'failed',
      exitCode: 1,
      outputs: {},
    };

    await queue.saveStepLog(jobId, stepId, `[JS EVAL ERROR]:\n${err.message}`);

    return {
      failed: true,
      cancelled: false,
      skipped: false,
      report: {
        id: stepId,
        name: stepName,
        status: 'failed' as const,
        durationMs: Date.now() - startTime,
        exitCode: 1,
        error: err.message,
        outputs: {},
        logContent: '',
      },
    };
  } finally {
    if (timeoutTimer) clearTimeout(timeoutTimer);
  }
}

async function evaluateEnv(env, context) {
  // Resolve entries in declaration order so later values can reference env.*.
  const evaluated: Record<string, string> = {};

  if (env) {
    for (const [key, val] of Object.entries(env)) {
      evaluated[key] = String(await SafeExpressionEvaluator.evaluateValue(val, { ...context, env: { ...context.env, ...evaluated } }));
    }
  }

  return evaluated;
}

const MAX_STORED_FILE_BYTES = 50 * 1024 * 1024;

function workspacePath(workingDir: string, relativePath: string): string {
  const root = Path.resolve(workingDir);
  const target = Path.resolve(root, relativePath);
  if (target !== root && !target.startsWith(`${root}${Path.sep}`)) throw new Error(`Stored file path escapes workspace: ${relativePath}`);
  return target;
}

function globMatches(relativePath: string, pattern: string): boolean {
  let expression = '^';
  for (let index = 0; index < pattern.length; index++) {
    if (pattern[index] === '*' && pattern[index + 1] === '*') {
      expression += '.*';
      index++;
    } else if (pattern[index] === '*') {
      expression += '[^/]*';
    } else {
      expression += pattern[index].replace(/[|\\{}()[\]^$+?.]/g, '\\$&');
    }
  }
  return new RegExp(`${expression}$`).test(relativePath);
}

function workspaceFilesForPatterns(paths: string[], workingDir: string): string[] {
  const root = Path.resolve(workingDir);
  const files: string[] = [];
  const visit = (directory: string) => {
    for (const entry of FS.readdirSync(directory, { withFileTypes: true })) {
      const absolute = Path.join(directory, entry.name);
      if (entry.isDirectory()) visit(absolute);
      else if (entry.isFile()) files.push(Path.relative(root, absolute).split(Path.sep).join('/'));
    }
  };
  visit(root);
  return files.filter((file) => paths.some((pattern) => {
    const target = workspacePath(workingDir, pattern);
    if (FS.existsSync(target)) {
      const stat = FS.statSync(target);
      if (stat.isFile()) return file === pattern;
      if (stat.isDirectory()) return file === pattern || file.startsWith(`${pattern.replace(/\/$/, '')}/`);
    }
    return globMatches(file, pattern);
  }));
}

async function collectStoredFiles(paths: string[], workingDir: string): Promise<Array<{ path: string; content: string }>> {
  const files = workspaceFilesForPatterns(paths, workingDir);
  let totalBytes = 0;
  return files.map((file) => {
    const content = FS.readFileSync(workspacePath(workingDir, file));
    if (content.byteLength > MAX_STORED_FILE_BYTES || (totalBytes += content.byteLength) > MAX_STORED_FILE_BYTES) {
      throw new Error(`Stored files exceed ${MAX_STORED_FILE_BYTES} bytes`);
    }
    return { path: file, content: content.toString('base64') };
  });
}

async function restoreStoredFiles(
  queue: QueueManager,
  kind: 'cache',
  ownerKey: string,
  paths: string[],
  workingDir: string,
): Promise<void> {
  for (const file of await queue.getStoredFiles(kind, ownerKey)) {
    if (!paths.some((pattern) => file.path === pattern || file.path.startsWith(`${pattern.replace(/\/$/, '')}/`) || globMatches(file.path, pattern))) continue;
    const target = workspacePath(workingDir, file.path);
    FS.mkdirSync(Path.dirname(target), { recursive: true });
    FS.writeFileSync(target, Buffer.from(file.content, 'base64'));
  }
}

function writeSecretFiles(secretFiles: Record<string, string> | undefined, values: Record<string, string>, workingDir: string): void {
  for (const [relativePath, secretName] of Object.entries(secretFiles || {})) {
    const value = values[secretName];
    if (value === undefined) throw new Error(`Secret '${secretName}' is not available for file '${relativePath}'`);
    const target = workspacePath(workingDir, relativePath);
    FS.mkdirSync(Path.dirname(target), { recursive: true });
    FS.writeFileSync(target, value, { mode: 0o600 });
    FS.chmodSync(target, 0o600);
  }
}

/**
 * Out-of-Process Shell/Container `run:` Step Execution
 */
async function executeRunStep(params: {
  workerId: string;
  jobId: string | number;
  stepContext: StepContext;
  executionContext: JobExecutionContext;
  driver: ExecutionDriver;
  queue: QueueManager;
  config: RunnerConfig;
}): Promise<ExecOutput> {
  const { workerId, jobId, stepContext, executionContext, driver, queue } = params;
  const { step } = stepContext;
  const stepId = step.id!;
  const stepName = step.name!;

  let handle: StepExecutionHandle;

  try {
    handle = driver.execute(stepContext);
  } catch (e) {
    handle = {
      done: Promise.resolve({
        exitCode: 1,
        durationMs: 0,
        error: new Error(String(e)),
      }),
      cancel: async () => {},
      logFilePath: '',
    };
  }

  activeStepHandles.add(handle);
  let cancelled = false;

  const cancelCheckInterval = setInterval(async () => {
    if (await queue.isCancelled(jobId)) {
      console.log(`[${workerId}] 🛑 Job #${jobId} was cancelled! Halting execution.`);
      cancelled = true;
      clearInterval(cancelCheckInterval);
      await handle.cancel();
    }
  }, 3000);

  const result: StepResult = await handle.done;
  clearInterval(cancelCheckInterval);
  activeStepHandles.delete(handle);

  if (handle.logFilePath && FS.existsSync(handle.logFilePath)) {
    try {
      const logContent = await driver.readLog(handle.logFilePath);
      await queue.saveStepLog(jobId, stepId, logContent);
    } catch (logErr: any) {
      console.error(`[${workerId}] ⚠️ Failed to read step log file:`, logErr.message);
    }
  }

  const failed = result.exitCode !== 0 || cancelled;
  const stepStatus = cancelled ? 'cancelled' : result.exitCode === 0 ? 'success' : 'failed';

  // Store status & exit code in context for downstream step conditions
  executionContext.steps[stepId] = {
    status: stepStatus,
    exitCode: result.exitCode,
    outputs: {},
  };

  if (failed) {
    console.error(`[${workerId}] ❌ Step [${stepId}] finished with status: ${stepStatus}`);
  }

  return {
    failed,
    cancelled,
    skipped: false,
    report: {
      id: stepId,
      name: stepName,
      status: stepStatus as any,
      durationMs: result.durationMs,
      exitCode: result.exitCode,
      error: result.error?.message,
      outputs: {},
      logContent: '',
    },
  };
}

/**
 * Fills skipped step records when execution stops early
 */
function fillSkippedSteps(steps: any[], startIndex: number, stepReports: StepReport[]) {
  for (let j = startIndex; j < steps.length; j++) {
    const skippedStep = steps[j];
    const stepId = skippedStep.id || `step-${j}`;
    stepReports[j] = {
      id: stepId,
      name: skippedStep.name || stepId,
      status: 'skipped',
      durationMs: 0,
      exitCode: 0,
      outputs: {},
      logContent: '',
    };
  }
}

/**
 * Constructs lightweight summary execution report
 */
function buildExecutionReport(
  job: JobRecord,
  status: WorkflowExecutionReport['status'],
  startTime: number,
  inputs: Record<string, any>,
  environment: Record<string, string>,
  stepReports: StepReport[],
  payload: any,
): WorkflowExecutionReport {
  return {
    jobId: String(job.id),
    parentId: String(job.parentId || ''),
    workflowName: job.workflow_id,
    status,
    durationMs: Date.now() - startTime,
    startedAt: new Date(startTime).toISOString(),
    finishedAt: status === 'running' ? undefined : new Date().toISOString(),
    inputs,
    environment,
    steps: stepReports,
    artifacts: [],
    rerunToken: JSON.stringify({ jobId: job.id, payload }),
  };
}
