import FS from 'node:fs';
import Path from 'node:path';
import { resolveDriver } from './drivers/index.js';
import { QueueManager } from './queue.js';
import { SafeExpressionEvaluator } from './safe-eval.js';
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
} from './types.js';
import { setupSignalHandlers } from './signals.js';

const DEBUG = !!process.env.DEBUG;

export const shutdownState = {
  isStopping: false,
};

// Global handle to active step for active process cancellation on SIGTERM
let activeStepHandle: { cancel: () => Promise<void> } | null = null;

/**
 * Called by signal handlers in index.ts during graceful shutdown
 */
export async function abortActiveWorkerTask() {
  if (activeStepHandle) {
    console.log('⚡ Cancelling active step execution handle due to worker shutdown...');
    await activeStepHandle.cancel();
    activeStepHandle = null;
  }
}

/**
 * Spawns worker loops as requested by configuration
 */
export function startWorkers(count: number, queue: QueueManager, secrets: SecretStore, config: RunnerConfig) {
  shutdownState.isStopping = false;
  const workerPromises = Array.from({ length: count }, (_, i) =>
    startWorkerLoop(`worker-${i + 1}`, queue, secrets, config),
  );
  setupSignalHandlers(workerPromises);
  return workerPromises;
}

/**
 * Main worker polling loop
 */
export async function startWorkerLoop(
  workerId: string,
  queue: QueueManager,
  secrets: SecretStore,
  config: RunnerConfig,
) {
  const driver = await resolveDriver();
  console.log(`[${workerId}] 🚀 Worker started. Driver: ${driver.name}`);

  while (!shutdownState.isStopping) {
    try {
      const job = await queue.claimNextJob();

      if (!job) {
        await new Promise((r) => setTimeout(r, 2000));
        continue;
      }

      await processJob({ workerId, job, queue, secrets, config, driver });
    } catch (error) {
      console.error(`[${workerId}] ⚠️ Worker execution loop error:`, error);
      await new Promise((r) => setTimeout(r, 5000));
    }
  }

  console.log(`[${workerId}] 🛑 Worker loop stopped cleanly.`);
}

/**
 * Processes a single job sequentially
 */
async function processJob(p: Processable) {
  const { workerId, job, config, secrets, queue } = p;
  console.log(`\n[${workerId}] 📦 Claimed Job #${job.id} (Workflow: ${job.workflow_id})`);

  const payload = (typeof job.payload === 'string' ? JSON.parse(job.payload) : job.payload) as JobPayload;
  const steps = payload.steps || [];
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
  };

  const context = { payload, steps, executionContext, ...p };
  const { cancelled, failed, stepReports } = await processSteps(context);
  const finalStatus = cancelled ? 'cancelled' : failed ? 'failed' : 'success';

  // 1. Update status in DB
  await queue.finishJob(job.id, finalStatus);
  console.log(`[${workerId}] ✅ Job #${job.id} completed as: ${finalStatus}`);

  // 2. Build lightweight summary report (NO heavy log blobs in this JSON)
  const executionReport = buildExecutionReport(
    job,
    finalStatus,
    jobStartTime,
    inputs,
    executionContext.env,
    stepReports,
    payload,
  );

  // 3. Save summary report to `jobs` table
  await queue.saveReport(job.id, executionReport);

  // 4. Dispatch to external reporters (Slack, JSON Files, etc.)
  await dispatchReporters(workerId, config.reporters, executionReport);
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

async function processSteps(p: ContextualizedProcessable): Promise<ProcessStepsOutput> {
  const { driver, workerId, queue, config, job, payload, steps, executionContext } = p;
  const stepReports: StepReport[] = [];
  let failed = false;
  let cancelled = false;

  try {
    if (payload.env) {
      Object.assign(executionContext.env, await evaluateEnv(payload.env, executionContext));
    }

    for (let i = 0; i < steps.length; i++) {
      const step = steps[i];
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
        stepReports.push(stepResult.report);
      }

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
  if (stepReports.length < steps.length) {
    fillSkippedSteps(steps, stepReports.length, stepReports);
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
      if (DEBUG) {
        console.log(`⏩ Skipped step ${step.id} based on condition: ${step.if}`, executionContext);
      }
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
      jobId: String(jobId),
      step,
      command: step.run!,
      timeoutMs: step.timeoutMs,
      image: step.image,
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
    if (DEBUG) {
      console.error(`⏩ Failed to run step ${step.id} based on condition: ${step.if}`, executionContext);
    }
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
  const { jobId, stepId, stepName, evalExpr } = stepContext;
  const startTime = Date.now();

  try {
    const evalResult = await SafeExpressionEvaluator.evaluateExpression(evalExpr, executionContext);

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
  stepId: string;
  stepName: string;
  executionContext: JobExecutionContext;
  driver: ExecutionDriver;
  queue: QueueManager;
  config: RunnerConfig;
}): Promise<ExecOutput> {
  const { workerId, jobId, stepContext, stepId, stepName, executionContext, driver, queue } = params;
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

  activeStepHandle = handle; // Bind global handle for signal cancellation
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
  activeStepHandle = null; // Unbind handle when step finishes

  if (handle.logFilePath && FS.existsSync(handle.logFilePath)) {
    try {
      const logContent = await driver.readLog(handle.logFilePath);
      await queue.saveStepLog(jobId, stepId, logContent);
    } catch (logErr: any) {
      console.error(`[${workerId}] ⚠️ Failed to read step log file:`, logErr.message);
    }
  }

  const failed = result.exitCode !== 0 || cancelled;
  const stepStatus = result.exitCode === 0 ? 'success' : cancelled ? 'cancelled' : 'failed';

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
    stepReports.push({
      id: stepId,
      name: skippedStep.name || stepId,
      status: 'skipped',
      durationMs: 0,
      exitCode: 0,
      outputs: {},
      logContent: '',
    });
  }
}

/**
 * Constructs lightweight summary execution report
 */
function buildExecutionReport(
  job: any,
  status: string,
  startTime: number,
  inputs: Record<string, any>,
  environment: Record<string, string>,
  stepReports: StepReport[],
  payload: any,
): WorkflowExecutionReport {
  return {
    jobId: job.id.toString(),
    workflowName: job.workflow_id,
    status: status as any,
    durationMs: Date.now() - startTime,
    startedAt: new Date(startTime).toISOString(),
    finishedAt: new Date().toISOString(),
    inputs,
    environment,
    steps: stepReports,
    artifacts: [],
    rerunToken: JSON.stringify({ jobId: job.id, payload }),
  };
}

/**
 * Dispatches report to registered plugins
 */
async function dispatchReporters(workerId: string, reporters: any[] = [], report: WorkflowExecutionReport) {
  if (!Array.isArray(reporters) || reporters.length === 0) return;

  console.log(`[${workerId}] 📢 Dispatching execution report to ${reporters.length} reporter(s)...`);

  await Promise.allSettled(
    reporters.map(async (reporter) => {
      try {
        await reporter.report(report);
      } catch (err: any) {
        console.error(`[${workerId}] ⚠️ Reporter '${reporter.name || 'unknown'}' failed:`, err.message);
      }
    }),
  );
}
