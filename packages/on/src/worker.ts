import { JobRecord, QueueManager } from './queue/dispatcher.js';
import { SecretStore } from './secrets/store.js';
import { resolveDriver } from './drivers/index.js';
import { StepContext, StepResult, ExecutionDriver } from './types.js';
import { SafeExpressionEvaluator } from './evaluator/safe-eval.js';
import { WorkflowExecutionReport, StepReport } from './reporters/types.js';
import { RunnerConfig } from './config.js';

export function startWorkers(count: number, queue: QueueManager, secrets: SecretStore, config: RunnerConfig) {
  return Array.from({ length: count }, (_, i) => startWorkerLoop(`worker-${i + 1}`, queue, secrets, config));
}

/**
 * Main worker loop: continuously polls the SQLite queue for pending jobs.
 */
export async function startWorkerLoop(
  workerId: string,
  queue: QueueManager,
  secrets: SecretStore,
  config: RunnerConfig,
) {
  const driver = await resolveDriver();
  console.log(`[${workerId}] 🚀 Worker started. Driver: ${driver.name}`);

  while (true) {
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
}

/**
 * Orchestrates the complete execution lifecycle for a claimed job.
 */
async function processJob(
  workerId: string,
  job: JobRecord,
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

  const executionContext = {
    inputs,
    env: { ...config.env },
    secrets: secrets.getAll(),
    steps: {} as Record<string, any>,
  };

  const stepReports: StepReport[] = [];
  let jobFailed = false;
  let isCancelled = false;

  // Execute steps sequentially
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

    stepReports.push(stepResult.report as StepReport);

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

  // Mark unexecuted steps as skipped if execution halted early
  if (jobFailed && stepReports.length < steps.length) {
    fillSkippedSteps(steps, stepReports.length, stepReports);
  }

  const finalStatus = isCancelled ? 'cancelled' : jobFailed ? 'failed' : 'success';

  // Persist status and execution report to SQLite Queue
  await queue.finishJob(job.id, finalStatus);
  console.log(`[${workerId}] ✅ Job #${job.id} completed as: ${finalStatus}`);

  const executionReport = buildExecutionReport(
    job,
    finalStatus,
    jobStartTime,
    inputs,
    executionContext.env,
    stepReports,
    payload,
  );
  await queue.saveReport(job.id, executionReport);

  // Dispatch reports to all registered plugins/reporters
  await dispatchReporters(workerId, config.reporters, executionReport);
}

/**
 * Routes step execution to either JS Eval or Process Driver handler.
 */
async function executeSingleStep(params: {
  workerId: string;
  jobId: string | number;
  step: any;
  stepIndex: number;
  totalSteps: number;
  executionContext: Record<string, any>;
  driver: ExecutionDriver;
  queue: QueueManager;
  config: RunnerConfig;
}) {
  const { workerId, step, stepIndex, totalSteps, executionContext } = params;
  const stepId = step.id || `step-${stepIndex}`;
  const stepName = step.name || stepId;

  console.log(`[${workerId}] ▶️ Running step ${stepIndex + 1}/${totalSteps}: ${stepName}`);

  if (step.eval) {
    return executeEvalStep(stepId, stepName, step.eval, executionContext);
  } else {
    return executeRunStep({ ...params, stepId, stepName });
  }
}

/**
 * Executes an in-process JS 'eval:' step.
 */
async function executeEvalStep(
  stepId: string,
  stepName: string,
  evalExpr: string,
  executionContext: Record<string, any>,
) {
  const startTime = Date.now();
  try {
    const evalResult = await SafeExpressionEvaluator.evaluateExpression(evalExpr, executionContext);
    executionContext.steps[stepId] = { status: 'success', outputs: evalResult };

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
        outputs: evalResult || {},
        logFilePath: '',
      },
    };
  } catch (err: any) {
    console.error(`[${stepId}] ❌ JS Eval step failed:`, err.message);
    executionContext.steps[stepId] = { status: 'failed', error: err.message };

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
 * Executes an out-of-process 'run:' step via the system execution driver.
 */
async function executeRunStep(params: {
  workerId: string;
  jobId: string | number;
  step: any;
  stepId: string;
  stepName: string;
  executionContext: Record<string, any>;
  driver: ExecutionDriver;
  queue: QueueManager;
  config: RunnerConfig;
}) {
  const { workerId, jobId, step, stepId, stepName, executionContext, driver, queue, config } = params;

  // Evaluate step environment variables using deterministic evaluateValue rule
  const evaluatedStepEnv: Record<string, string> = {};
  if (step.env) {
    for (const [key, val] of Object.entries(step.env)) {
      evaluatedStepEnv[key] = String(await SafeExpressionEvaluator.evaluateValue(val, executionContext));
    }
  }

  const stepCtx: StepContext = {
    jobId: jobId.toString(),
    stepId,
    workspacePath: `${config.storagePath || '/tmp/workspaces'}/job-${jobId}`,
    command: step.run,
    image: step.image,
    env: {
      ...executionContext.env,
      ...evaluatedStepEnv,
    },
    timeoutMs: step.timeoutMs,
  };

  const handle = await driver.execute(stepCtx);
  let isCancelled = false;

  // Periodically poll SQLite for mid-run job cancellation signals
  const cancelCheckInterval = setInterval(async () => {
    if (await queue.isCancelled(jobId)) {
      console.log(`[${workerId}] 🛑 Job #${jobId} was cancelled! Halting step execution.`);
      isCancelled = true;
      clearInterval(cancelCheckInterval);
      await handle.cancel();
    }
  }, 3000);

  const result: StepResult = await handle.done;
  clearInterval(cancelCheckInterval);

  const failed = result.exitCode !== 0 || isCancelled;
  const stepStatus = result.exitCode === 0 ? 'success' : isCancelled ? 'cancelled' : 'failed';

  if (failed) {
    console.error(`[${workerId}] ❌ Step [${stepId}] failed with status: ${stepStatus}`);
  }

  executionContext.steps[stepId] = { status: stepStatus, exitCode: result.exitCode };

  return {
    failed,
    isCancelled,
    report: {
      id: stepId,
      name: stepName,
      status: stepStatus,
      durationMs: result.durationMs,
      exitCode: result.exitCode,
      error: result.error?.message,
      outputs: executionContext.steps[stepId]?.outputs || {},
      logFilePath: handle.logFilePath,
    },
  };
}

/**
 * Fills skipped status for remaining unexecuted steps.
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
 * Assembles the frozen WorkflowExecutionReport JSON payload.
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
 * Dispatches the execution report concurrently to all registered reporters.
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
