import fs from 'node:fs';
import { resolveDriver } from './drivers/index.js';
import { QueueManager } from './queue.js';
import { SafeExpressionEvaluator } from './safe-eval.js';
import { SecretStore } from './secrets.js';
import {
  ExecutionDriver,
  RunnerConfig,
  StepContext,
  StepReport,
  StepResult,
  WorkflowExecutionReport,
  WorkflowStep,
} from './types.js';

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
  return Array.from({ length: count }, (_, i) => startWorkerLoop(`worker-${i + 1}`, queue, secrets, config));
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

      await processJob(workerId, job, queue, secrets, config, driver);
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
async function processJob(
  workerId: string,
  job: any,
  queue: QueueManager,
  secrets: SecretStore,
  config: RunnerConfig,
  driver: ExecutionDriver,
) {
  console.log(`\n[${workerId}] 📦 Claimed Job #${job.id} (Workflow: ${job.workflow_id})`);

  const payload = typeof job.payload === 'string' ? JSON.parse(job.payload) : job.payload;
  const steps = payload.steps || [];
  const inputs = payload.inputs || {};
  const jobStartTime = Date.now();

  // Step Execution Context available in expressions: ${steps.step1.outputs.id}
  const executionContext = {
    inputs,
    env: { ...config.env },
    secrets: secrets.getAll(),
    steps: {} as Record<string, { status: string; exitCode: number; outputs: any }>,
  };

  const stepReports: StepReport[] = [];
  let jobFailed = false;
  let isCancelled = false;

  for (let i = 0; i < steps.length; i++) {
    const step = steps[i];
    const stepResult = await executeSingleStep({
      workerId,
      jobId: job.id,
      step,
      stepIndex: i,
      totalSteps: steps.length,
      executionContext,
      driver,
      queue,
      config,
    });

    stepReports.push(stepResult.report);

    if (stepResult.isCancelled) {
      isCancelled = true;
      jobFailed = true;
      break;
    }

    if (stepResult.failed) {
      jobFailed = true;
      break;
    }
  }

  // Mark unexecuted steps as skipped
  if (jobFailed && stepReports.length < steps.length) {
    fillSkippedSteps(steps, stepReports.length, stepReports);
  }

  const finalStatus = isCancelled ? 'cancelled' : jobFailed ? 'failed' : 'success';

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

/**
 * Step Dispatcher: Routes to either `eval:` or `run:` execution
 */
async function executeSingleStep(params: {
  workerId: string;
  jobId: string | number;
  step: WorkflowStep;
  stepIndex: number;
  totalSteps: number;
  executionContext: Record<string, any>;
  driver: ExecutionDriver;
  queue: QueueManager;
  config: RunnerConfig;
}) {
  const { workerId, step, stepIndex, totalSteps } = params;
  const stepId = step.id || `step-${stepIndex}`;
  const stepName = step.name || stepId;

  console.log(`[${workerId}] ▶️ Running step ${stepIndex + 1}/${totalSteps}: ${stepName}`);

  if (step.eval) {
    return executeEvalStep({ ...params, stepId, stepName, evalExpr: step.eval });
  } else {
    return executeRunStep({ ...params, stepId, stepName });
  }
}

/**
 * In-Process JS `eval:` Step Execution
 */
async function executeEvalStep(params: {
  queue: QueueManager;
  jobId: string | number;
  stepId: string;
  stepName: string;
  evalExpr: string;
  executionContext: Record<string, any>;
}) {
  const { queue, jobId, stepId, stepName, evalExpr, executionContext } = params;
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
      isCancelled: false,
      report: {
        id: stepId,
        name: stepName,
        status: 'success' as const,
        durationMs: Date.now() - startTime,
        exitCode: 0,
        outputs: executionContext.steps[stepId].outputs,
        logFilePath: '',
      },
    };
  } catch (err: any) {
    console.error(`[${stepId}] ❌ JS Eval step failed:`, err.message);

    executionContext.steps[stepId] = {
      status: 'failed',
      exitCode: 1,
      outputs: {},
    };

    await queue.saveStepLog(jobId, stepId, `[JS EVAL ERROR]:\n${err.message}`);

    return {
      failed: true,
      isCancelled: false,
      report: {
        id: stepId,
        name: stepName,
        status: 'failed' as const,
        durationMs: Date.now() - startTime,
        exitCode: 1,
        error: err.message,
        outputs: {},
        logFilePath: '',
      },
    };
  }
}

/**
 * Out-of-Process Shell/Container `run:` Step Execution
 */
async function executeRunStep(params: {
  workerId: string;
  jobId: string | number;
  step: WorkflowStep;
  stepId: string;
  stepName: string;
  executionContext: Record<string, any>;
  driver: ExecutionDriver;
  queue: QueueManager;
  config: RunnerConfig;
}) {
  const { workerId, jobId, step, stepId, stepName, executionContext, driver, queue, config } = params;

  // Evaluate step environment variables
  const evaluatedStepEnv: Record<string, string> = {};
  if (step.env) {
    for (const [key, val] of Object.entries(step.env)) {
      evaluatedStepEnv[key] = String(await SafeExpressionEvaluator.evaluateValue(val, executionContext));
    }
  }

  const stepCtx: StepContext = {
    jobId: jobId.toString(),
    stepId,
    workspacePath: `${config.storagePath}/job-${jobId}`,
    command: step.run!,
    image: step.image,
    env: {
      ...executionContext.env,
      ...evaluatedStepEnv,
    },
    timeoutMs: step.timeoutMs,
  };

  const handle = await driver.execute(stepCtx);
  activeStepHandle = handle; // Bind global handle for signal cancellation

  let isCancelled = false;

  const cancelCheckInterval = setInterval(async () => {
    if (await queue.isCancelled(jobId)) {
      console.log(`[${workerId}] 🛑 Job #${jobId} was cancelled! Halting execution.`);
      isCancelled = true;
      clearInterval(cancelCheckInterval);
      await handle.cancel();
    }
  }, 3000);

  const result: StepResult = await handle.done;
  clearInterval(cancelCheckInterval);
  activeStepHandle = null; // Unbind handle when step finishes

  if (handle.logFilePath && fs.existsSync(handle.logFilePath)) {
    try {
      const logContent = fs.readFileSync(handle.logFilePath, 'utf-8');
      await queue.saveStepLog(jobId, stepId, logContent);
    } catch (logErr: any) {
      console.error(`[${workerId}] ⚠️ Failed to read step log file:`, logErr.message);
    }
  }

  const failed = result.exitCode !== 0 || isCancelled;
  const stepStatus = result.exitCode === 0 ? 'success' : isCancelled ? 'cancelled' : 'failed';

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
    isCancelled,
    report: {
      id: stepId,
      name: stepName,
      status: stepStatus as any,
      durationMs: result.durationMs,
      exitCode: result.exitCode,
      error: result.error?.message,
      outputs: {},
      logFilePath: handle.logFilePath || '',
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
      logFilePath: '',
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
