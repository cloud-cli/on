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
} from './types.js';
import { setupSignalHandlers } from './signals.js';
import { consumeRunnerEvents } from './events.js';
import { PluginManager } from './plugins/manager.js';
import { WorkflowRepository } from './workflows.js';
import { debug } from './debug.js';

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
  const steps = p.workflow.steps;
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
  const pluginManager = new PluginManager(config.plugins);
  const workflowContext = {
    jobId: String(job.id),
    workflowName: job.workflow_id,
    inputs,
    runUrl: new URL(`/runs/${job.id}`, config.serverUrl).toString(),
  };
  await pluginManager.triggerWorkflowStart(workflowContext);

  const context = { payload, steps, executionContext, ...p };
  const { cancelled, failed } = await processSteps(context, executionReport);
  const finalStatus = cancelled ? 'cancelled' : failed ? 'failed' : 'success';

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
    if (p.workflow?.env) {
      Object.assign(executionContext.env, await evaluateEnv(p.workflow.env, executionContext));
    }

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

      const stepResult = await executeSingleStep({
        workerId,
        jobId: job.id,
        step,
        stepIndex: i,
        executionContext,
        driver,
        queue,
        config,
      });

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
      timeoutMs: step.timeoutMs,
      image: step.image,
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
  } catch (e) {
    debug(`⏩ Failed to run step ${step.id}`, executionContext, e);

    return {
      failed: true,
      cancelled: false,
      skipped: false,
      report: null,
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

  try {
    const evalResult = await SafeExpressionEvaluator.evaluateExpression(step.eval!, executionContext);

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
  }
}

async function evaluateEnv(env, context) {
  // Evaluate step environment variables
  const evaluated: Record<string, string> = {};

  if (env) {
    for (const [key, val] of Object.entries(env)) {
      evaluated[key] = String(await SafeExpressionEvaluator.evaluateValue(val, context));
    }
  }

  return evaluated;
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
