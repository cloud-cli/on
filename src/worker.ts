import FS from "node:fs";
import { createHash, randomUUID } from "node:crypto";
import Path from "node:path";
import { resolveDriver } from "./drivers/index.js";
import { QueueManager } from "./queue.js";
import { SafeExpressionEvaluator, workspaceFiles } from "./safe-eval.js";
import { SecretStore } from "./secrets.js";
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
  RecipeCallInstanceReport,
  FinalJobStatus,
  WorkerExecutionQueue,
} from "./types.js";
import { setupSignalHandlers } from "./signals.js";
import { consumeRunnerEvents } from "./events.js";
import { PluginManager } from "./plugins/manager.js";
import { DEFAULT_STEP_TIMEOUT_MS } from "./workflow-constants.js";
import { debug } from "./debug.js";
import { expandMatrix } from "./parser/matrix-expander.js";
import { validateRecipeInputs } from "./recipe-schema.js";
import { createWorkflowPlugin } from "./plugins/workflow-registry.js";
import { RUNNER_VERSION } from "./version.js";
import { activeStepHandles, shutdownState } from "./worker-state.js";
import { createStepAttemptSnapshot } from "./step-attempt-snapshot.js";
export { abortActiveJob, abortActiveWorkerTask, shutdownState } from "./worker-state.js";

let eventStreamController: AbortController | null = null;
let wakeScheduler: (() => void) | null = null;

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
  const { WorkflowRepository } = await import("./workflows.js");
  const workflows = new WorkflowRepository();
  const activeJobs = new Set<Promise<void>>();
  let wakeVersion = 0;
  let pendingWake: (() => void) | null = null;
  const wake = () => {
    wakeVersion++;
    pendingWake?.();
  };
  const workerId = process.env.WORKER_NAME || "cli";

  wakeScheduler = wake;
  eventStreamController = new AbortController();
  const eventStream = maintainEventStream(config, eventStreamController.signal, wake);
  const heartbeat = setInterval(
    () => void notifyWorkerHeartbeat(config, workerId, concurrency, activeJobs.size),
    15_000,
  );
  heartbeat.unref();
  void notifyWorkerHeartbeat(config, workerId, concurrency, activeJobs.size);
  console.log(
    `🚀 Worker scheduler started. Driver: ${driver.name}. Concurrency: ${concurrency}. Tags: ${config.tags.join(", ") || "(none)"}`,
  );

  while (!shutdownState.isStopping) {
    const observedWake = wakeVersion;

    try {
      while (activeJobs.size < concurrency && !shutdownState.isStopping) {
        const job = await queue.claimNextJob(config.tags);
        if (!job) {
          break;
        }
        if (shutdownState.isStopping) {
          await queue.releaseJob(job.id);
          break;
        }

        // Match the ID written by QueueManager.claimNextJob so the server can
        // authorize this machine's request for the claimed job's secrets.
        let task: Promise<void>;
        task = (async () => {
          void notifyJobChange(config, job.id);
          const workflow = await workflows.getRevision(job.workflow_id, job.workflow_revision);
          if (!workflow) {
            await queue.finishJob(job.id, "failed");
            throw new Error(`Workflow ${job.workflow_id} revision ${job.workflow_revision} was not found`);
          }
          const jobSecrets = new SecretStore();
          jobSecrets.replace(await fetchJobSecrets(config, workerId, job.id));
          await processJob({
            workerId,
            job,
            queue,
            secrets: jobSecrets,
            config,
            driver,
            workflow,
          });
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
      console.error("⚠️ Worker scheduler claim error:", error);
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
  clearInterval(heartbeat);
  await Promise.allSettled(activeJobs);
  await eventStream;
  wakeScheduler = null;
  console.log("🛑 Worker scheduler stopped cleanly.");
}

async function maintainEventStream(config: RunnerConfig, signal: AbortSignal, wake: () => void): Promise<void> {
  let retryMs = 1000;

  while (!signal.aborted) {
    try {
      await consumeRunnerEvents(
        config.serverUrl,
        signal,
        (event, data) => {
          if (event !== "jobs.available") {
            return;
          }
          const requiredTags = Array.isArray(data.tags)
            ? data.tags.filter((tag): tag is string => typeof tag === "string")
            : [];
          if (requiredTags.every((tag) => config.tags.includes(tag))) {
            wake();
          }
        },
        wake,
        config.workerToken,
      );
      retryMs = 1000;
    } catch (error: any) {
      if (signal.aborted || error?.name === "AbortError") {
        break;
      }
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
    if (getWakeVersion() !== observedWake) {
      return resolve();
    }

    const timer = setTimeout(resolve, 60_000);
    setWake(() => {
      clearTimeout(timer);
      resolve();
    });
  });
}

function abortableDelay(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (signal.aborted) {
      return resolve();
    }
    const onAbort = () => {
      clearTimeout(timer);
      resolve();
    };
    const timer = setTimeout(() => {
      signal.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    signal.addEventListener("abort", onAbort, { once: true });
  });
}

async function notifyJobChange(config: RunnerConfig, jobId: string | number): Promise<void> {
  if (!config.workerToken) {
    return;
  }

  try {
    const response = await fetch(new URL("/api/v1/events", config.serverUrl), {
      method: "POST",
      headers: {
        Authorization: `Bearer ${config.workerToken}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ jobId }),
      signal: AbortSignal.timeout(5000),
    });
    if (!response.ok) {
      debug(`Failed to publish job status event: HTTP ${response.status}`);
    }
  } catch (error) {
    debug("Failed to publish job status event:", error);
  }
}

async function notifyWorkerHeartbeat(
  config: RunnerConfig,
  workerId: string,
  concurrency: number,
  activeJobs: number,
): Promise<void> {
  if (!config.workerToken) {
    return;
  }
  try {
    await fetch(new URL("/api/v1/workers/heartbeat", config.serverUrl), {
      method: "POST",
      headers: {
        Authorization: `Bearer ${config.workerToken}`,
        "Content-Type": "application/json",
        "X-Runner-Worker-Id": workerId,
      },
      body: JSON.stringify({
        workerId,
        version: RUNNER_VERSION,
        tags: config.tags,
        concurrency,
        activeJobs,
      }),
      signal: AbortSignal.timeout(5000),
    });
  } catch (error) {
    debug("Failed to publish worker heartbeat:", error);
  }
}

async function fetchJobSecrets(
  config: RunnerConfig,
  workerId: string,
  jobId: string | number,
): Promise<Record<string, string>> {
  if (!config.workerToken) {
    return {};
  }
  try {
    const response = await fetch(new URL(`/api/v1/jobs/${jobId}/secrets`, config.serverUrl), {
      headers: {
        Authorization: `Bearer ${config.workerToken}`,
        "X-Runner-Worker-Id": workerId,
      },
      signal: AbortSignal.timeout(5000),
    });
    if (!response.ok) {
      throw new Error(`HTTP ${response.status}`);
    }
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
  const { workerId, job, config, secrets } = p;
  const redactValue = (value: any): any => {
    if (typeof value === "string") {
      return secrets.redactText(value);
    }
    if (Array.isArray(value)) {
      return value.map(redactValue);
    }
    if (value && typeof value === "object") {
      return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, redactValue(item)]));
    }
    return value;
  };
  const queue = new Proxy(p.queue, {
    get(target, property, receiver) {
      const value = Reflect.get(target, property, receiver);
      if (property === "saveStepLog") {
        return (jobId: string | number, stepId: string, content: string) => {
          const redacted = secrets.redactText(content);
          return value.call(target, jobId, stepId, redacted);
        };
      }
      if (property === "saveStepAttempt") {
        if (typeof value !== "function") {
          return undefined;
        }
        return (record: any) => {
          let snapshotJson: string | undefined;
          if (typeof record.snapshotJson === "string") {
            try {
              const snapshot = redactValue(JSON.parse(record.snapshotJson));
              const encoded = JSON.stringify(snapshot);
              snapshotJson =
                Buffer.byteLength(encoded, "utf8") <= 65536
                  ? encoded
                  : JSON.stringify({ version: 1, status: "omitted", reason: "too_large" });
            } catch {
              snapshotJson = JSON.stringify({ version: 1, status: "omitted", reason: "too_large" });
            }
          }
          return value.call(target, {
            ...record,
            error: record.error ? secrets.redactText(record.error).slice(0, 4000) : undefined,
            logContent: secrets.redactText(record.logContent).slice(0, 65536),
            snapshotJson,
          });
        };
      }
      if (property === "saveReport") {
        return (jobId: string | number, report: WorkflowExecutionReport) =>
          value.call(target, jobId, redactValue(report));
      }
      if (property === "completeJob") {
        return (jobId: string | number, status: string, report: WorkflowExecutionReport) =>
          value.call(target, jobId, status, redactValue(report));
      }
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
  console.log(`\n[${workerId}] 📦 Claimed Job #${job.id} (Workflow: ${job.workflow_id})`);

  const payload = (typeof job.payload === "string" ? JSON.parse(job.payload) : job.payload) as JobPayload;
  if (
    payload.inputsRaw &&
    typeof payload.inputsRaw === "object" &&
    (payload.inputsRaw as unknown as { type?: unknown }).type === "Buffer"
  ) {
    payload.inputsRaw = Buffer.from((payload.inputsRaw as unknown as { data: number[] }).data);
  }
  if (!p.workflow) {
    throw new Error(`Workflow ${job.workflow_id} revision ${job.workflow_revision} was not resolved`);
  }
  const candidateWorkflow = payload.matrix
    ? expandMatrix(p.workflow).find(
        (variant) => JSON.stringify(variant.matrixContext) === JSON.stringify(payload.matrix),
      )
    : p.workflow;
  if (!candidateWorkflow) {
    throw new Error(`Matrix variant for job ${job.id} was not found`);
  }
  const resolvedWorkflow = candidateWorkflow as typeof p.workflow;
  const processable = {
    ...p,
    queue,
    workflow: resolvedWorkflow,
    writeOnlyInputNames: Object.entries(resolvedWorkflow._recipeInputSchema?.properties || {})
      .filter(([, schema]) => (schema as { writeOnly?: boolean }).writeOnly === true)
      .map(([name]) => name),
  };
  const steps = resolvedWorkflow.steps;
  const postSteps = resolvedWorkflow.post || [];
  const inputs = { ...(payload.inputs || {}) };
  const reportInputs = { ...inputs, ...(resolvedWorkflow._recipeInputs || {}) };
  const jobStartTime = Date.now();
  const jobStoragePath = Path.join(config.storagePath, `job-${job.id}`);
  const storagePath = p.executionId
    ? Path.join(jobStoragePath, `execution-${createHash("sha256").update(p.executionId).digest("hex")}`)
    : jobStoragePath;
  const logsDir = Path.join(storagePath, "logs");
  const workingDir = Path.join(storagePath, "wd");
  const runUrl = new URL(`/ui/runs/${job.id}`, config.serverUrl).toString();

  // Step Execution Context available in expressions: ${steps.step1.outputs.id}
  const executionContext: JobExecutionContext = {
    inputs,
    headers: payload.headers || {},
    inputsRaw: payload.inputsRaw,
    env: {
      ...config.env,
      CI: "true",
      CI_JOB_ID: String(job.id),
      CI_JOB_NAME: resolvedWorkflow.name,
      CI_JOB_URL: runUrl,
    },
    secrets: secrets.getAll(),
    steps: {},
    logsDir,
    workingDir,
    files: workspaceFiles(workingDir),
  };
  let cacheKey = "";

  const stepReports = [...steps, ...postSteps].map((step, index): StepReport => {
    step.id ||= `step-${index}`;
    step.name ||= step.id;

    return {
      id: step.id,
      name: step.name,
      status: "pending",
      durationMs: 0,
      outputs: {},
      logContent: "",
    };
  });
  const executionReport = buildExecutionReport(
    job,
    "running",
    jobStartTime,
    reportInputs,
    executionContext.env,
    stepReports,
    payload,
  );

  // Make the trace available before the first step starts.
  await queue.saveReport(job.id, executionReport);
  void notifyJobChange(config, job.id);
  try {
    Object.assign(executionContext.env, await evaluateEnv(resolvedWorkflow.env, executionContext));
    Object.assign(executionContext.env, {
      CI: "true",
      CI_JOB_ID: String(job.id),
      CI_JOB_NAME: resolvedWorkflow.name,
      CI_JOB_URL: runUrl,
    });
    if (resolvedWorkflow._recipeInputs) {
      const evaluateRecipeValue = async (value: unknown): Promise<unknown> => {
        if (typeof value === "string") {
          const directExpression = value.match(/^\$\{([\s\S]+)\}$/);
          if (directExpression) {
            return SafeExpressionEvaluator.evaluateExpression(directExpression[1], executionContext);
          }
          return SafeExpressionEvaluator.evaluateValue(value, executionContext);
        }
        if (Array.isArray(value)) {
          return Promise.all(value.map(evaluateRecipeValue));
        }
        if (value && typeof value === "object") {
          const entries = await Promise.all(
            Object.entries(value).map(async ([key, item]) => [key, await evaluateRecipeValue(item)] as const),
          );
          return Object.fromEntries(entries);
        }
        return value;
      };
      const resolvedInputs: Record<string, unknown> = {};
      for (const [key, value] of Object.entries(resolvedWorkflow._recipeInputs)) {
        resolvedInputs[key] = await evaluateRecipeValue(value);
      }
      if (resolvedWorkflow._recipeInputSchema) {
        validateRecipeInputs(resolvedWorkflow._recipeInputSchema, resolvedInputs, "with");
      }
      Object.assign(executionContext.inputs, resolvedInputs);
    }
    writeSecretFiles(resolvedWorkflow.secretFiles, secrets, workingDir);
    cacheKey = resolvedWorkflow.cache
      ? String(await SafeExpressionEvaluator.evaluateValue(resolvedWorkflow.cache.key, executionContext))
      : "";
    if (cacheKey && resolvedWorkflow.cache) {
      await restoreStoredFiles(
        queue,
        "cache",
        `${job.workflow_id}:${cacheKey}`,
        resolvedWorkflow.cache.paths,
        workingDir,
      );
    }
    await queue.saveReport(job.id, executionReport);
  } catch (error: any) {
    executionReport.status = "failed";
    executionReport.finishedAt = new Date().toISOString();
    executionReport.durationMs = Date.now() - jobStartTime;
    const failedReport = {
      ...executionReport,
      steps: executionReport.steps.map((step) => ({
        ...step,
        status: "skipped" as const,
      })),
    };
    await queue.completeJob(job.id, "failed", failedReport);
    console.error(`[${workerId}] ❌ Job setup failed:`, error);
    return;
  }
  const plugins = [...config.plugins];
  for (const definition of resolvedWorkflow.plugins || []) {
    try {
      const pluginSecrets = await evaluateEnv(definition.secrets, executionContext);
      plugins.push(createWorkflowPlugin({ ...definition, secrets: pluginSecrets }));
    } catch (error) {
      console.error(`[${workerId}] Workflow plugin '${definition.name}' failed to initialize:`, error);
    }
  }
  const pluginManager = new PluginManager(plugins);
  const workflowContext = {
    jobId: String(job.id),
    workflowName: resolvedWorkflow.name,
    inputs,
    runUrl,
  };
  await pluginManager.triggerWorkflowStart(workflowContext);

  const context = { payload, steps, executionContext, ...processable };
  const { cancelled, failed } = await processSteps(context, executionReport);
  let finalStatus: FinalJobStatus = cancelled ? "cancelled" : failed ? "failed" : "success";
  if (finalStatus === "success") {
    try {
      const artifacts = resolvedWorkflow.artifacts
        ? await collectStoredFiles(resolvedWorkflow.artifacts.paths, workingDir)
        : [];
      if (artifacts.length) {
        await queue.saveStoredFiles("artifact", String(job.id), artifacts);
        executionReport.artifacts = artifacts.map((file) => file.path);
      }
      if (cacheKey && resolvedWorkflow.cache) {
        const cacheFiles = await collectStoredFiles(resolvedWorkflow.cache.paths, workingDir);
        if (cacheFiles.length) {
          await queue.saveStoredFiles("cache", `${job.workflow_id}:${cacheKey}`, cacheFiles);
        }
      }
    } catch (error: any) {
      console.error(`[${workerId}] ⚠️ Failed to store workflow files:`, error);
      finalStatus = "failed";
    }
  }

  // Lifecycle hooks begin only after setup succeeds, and post-step failures are non-fatal.
  executionContext.env.CI_JOB_STATUS = finalStatus;
  executionContext.job = { status: finalStatus, runUrl };
  if (postSteps.length) {
    const postContext = { ...context, steps: postSteps };
    try {
      await processSteps(postContext, executionReport, steps.length, true);
    } catch (error) {
      console.error(`[${workerId}] Post steps failed:`, error);
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
  reportOffset = 0,
  nonFatal = false,
): Promise<ProcessStepsOutput> {
  const { driver, workerId, queue, config, job, payload, steps, executionContext } = p;
  const stepReports = executionReport.steps;
  let attemptLogContent = "";
  const attemptQueue = new Proxy(queue, {
    get(target, property, receiver) {
      const value = Reflect.get(target, property, receiver);
      if (property === "saveStepLog") {
        return (jobId: string | number, stepId: string, content: string) => {
          const safeContent = p.secrets.redactText(content);
          attemptLogContent = `${attemptLogContent}${safeContent}`.slice(-65536);
          return value.call(target, jobId, stepId, safeContent);
        };
      }
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
  let failed = false;
  let cancelled = false;
  let processedSteps = 0;

  try {
    for (let i = 0; i < steps.length; i++) {
      const step = steps[i];
      const stepStartedAt = new Date().toISOString();
      const reportIndex = reportOffset + i;
      stepReports[reportIndex] = {
        ...stepReports[reportIndex],
        status: "running",
        durationMs: 0,
        exitCode: undefined,
        error: undefined,
        outputs: {},
        logContent: "",
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
        const attemptStartedAt = new Date().toISOString();
        const attemptStartedMs = Date.now();
        const attemptId = randomUUID();
        attemptLogContent = "";
        if (!queue.saveStepAttemptStart) {
          throw new Error("Durable step attempt start persistence is unavailable");
        }
        await queue.saveStepAttemptStart({
          jobId: job.id,
          stepId: step.id!,
          attempt,
          startedAt: attemptStartedAt,
          attemptId,
        });
        stepResult = await executeSingleStep({
          workerId,
          jobId: job.id,
          step,
          stepIndex: i,
          attempt,
          executionContext,
          recipeSecrets: p.workflow?._recipeSecrets,
          pinnedRecipeFunctions: p.workflow?._pinnedRecipeFunctions,
          processable: p,
          executionReport,
          reportOffset,
          driver,
          queue: attemptQueue,
          config,
        });
        const attemptCompletedAt = new Date().toISOString();
        await queue.saveStepAttempt?.({
          jobId: job.id,
          stepId: step.id!,
          attempt,
          attemptId,
          status: stepResult.report?.status || (stepResult.skipped ? "skipped" : "failed"),
          startedAt: attemptStartedAt,
          completedAt: attemptCompletedAt,
          durationMs: stepResult.report?.durationMs ?? Date.now() - attemptStartedMs,
          exitCode: stepResult.report?.exitCode,
          error: stepResult.report?.error,
          logContent: attemptLogContent,
          snapshotJson: JSON.stringify(
            createStepAttemptSnapshot({
              inputs: executionContext.inputs,
              priorSteps: executionContext.steps,
              outputs: stepResult.report?.outputs || {},
              writeOnlyInputNames: p.writeOnlyInputNames,
            }),
          ),
        });
        if (!stepResult.failed || stepResult.cancelled || attempt > retries) {
          break;
        }
        console.log(`[${workerId}] 🔁 Retrying step [${step.id}] (${attempt}/${retries + 1})`);
      }

      if (stepResult.report) {
        stepReports[reportIndex] = {
          ...stepResult.report,
          startedAt: stepStartedAt,
          finishedAt: new Date().toISOString(),
        };
      } else if (stepResult.skipped) {
        stepReports[reportIndex] = {
          ...stepReports[reportIndex],
          status: "skipped",
          durationMs: 0,
          exitCode: 0,
          finishedAt: new Date().toISOString(),
        };
      } else {
        stepReports[reportIndex] = {
          ...stepReports[reportIndex],
          status: "failed",
          durationMs: 0,
          exitCode: 1,
          error: "Step failed before execution started",
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

      if (stepResult.cancelled && !nonFatal) {
        cancelled = true;
        failed = true;
        break;
      }

      if (stepResult.failed && !nonFatal) {
        failed = true;
        break;
      }
    }
  } catch (e) {
    console.log("🛑 Step failed", e);
    failed = !nonFatal;
  }

  // Mark unexecuted steps as skipped
  if (processedSteps < steps.length) {
    fillSkippedSteps(steps, processedSteps, stepReports, reportOffset);
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
  recipeSecrets?: Record<string, string>;
  pinnedRecipeFunctions?: NonNullable<Processable["workflow"]>["_pinnedRecipeFunctions"];
  processable: ContextualizedProcessable;
  executionReport: WorkflowExecutionReport;
  reportOffset: number;
  driver: ExecutionDriver;
  queue: WorkerExecutionQueue;
  config: RunnerConfig;
}): Promise<ExecOutput> {
  const { step, stepIndex, executionContext } = params;
  const stepExecutionContext =
    step.__recipeTemplate && params.recipeSecrets
      ? {
          ...executionContext,
          secrets: Object.fromEntries(
            Object.entries(params.recipeSecrets).flatMap(([alias, source]) =>
              Object.hasOwn(executionContext.secrets, source) ? [[alias, executionContext.secrets[source]]] : [],
            ),
          ),
        }
      : executionContext;
  step.id ||= `step-${stepIndex}`;
  step.name ||= step.id;

  if (step.if) {
    const shouldRun = await SafeExpressionEvaluator.evaluateConditions(step.if, stepExecutionContext);

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

  if ("call" in step) {
    const started = Date.now();
    const callTarget = typeof step.call === "string" ? step.call : "";
    const callMatch = callTarget.match(
      /^([a-z0-9][a-z0-9-]{0,62})\/([a-z0-9][a-z0-9-]{0,62})@([1-9][0-9]*)#([A-Za-z_][A-Za-z0-9_]*)$/,
    );
    const callPath = `${step.id}#attempt-${params.attempt}`;
    const callInstance: RecipeCallInstanceReport = {
      callId: `${params.jobId}:${callPath}`,
      parentCallId: params.processable.parentCallId,
      callSiteId: step.id!,
      target: callTarget,
      functionName: callMatch?.[4] || "",
      status: "running",
      stepIds: [] as string[],
      inputs: {},
      outputs: {},
      durationMs: 0,
    };
    (params.executionReport.callInstances ||= []).push(callInstance);
    try {
      const match = callMatch;
      if (!match) {
        throw new Error("Nested recipe call must use an exact pinned target");
      }
      const [, namespace, slug, versionText, functionName] = match;
      const version = Number(versionText);
      if (!Number.isSafeInteger(version) || (await params.queue.isRecipeVersionRevoked(namespace, slug, version))) {
        throw new Error(`Pinned recipe ${step.call} is unavailable or revoked`);
      }
      const key = `${namespace}/${slug}@${version}#${functionName}`;
      const isPinned = params.processable.workflow?._pinnedReferences?.some(
        (reference) =>
          reference.namespace === namespace &&
          reference.slug === slug &&
          reference.version === version &&
          reference.function === functionName,
      );
      if (!isPinned) {
        throw new Error(`Nested recipe target is not in the immutable pin set: ${key}`);
      }
      const fn = params.pinnedRecipeFunctions?.[key];
      if (!fn) {
        throw new Error(`Pinned recipe function snapshot is missing: ${key}`);
      }
      if ((params.processable.nestedCallDepth || 0) >= 16) {
        throw new Error("Nested recipe call depth exceeds maximum of 16 levels");
      }
      const evaluateBinding = async (value: unknown): Promise<unknown> => {
        if (typeof value === "string") {
          const expression = value.match(/^\$\{((?:inputs|steps|job|matrix|github)(?:\.[A-Za-z_$][\w$]*)+)\}$/);
          if (expression) {
            const inputProperty = expression[1].match(/^inputs\.([A-Za-z_$][\w$]*)/)?.[1];
            if (inputProperty && params.processable.writeOnlyInputNames?.includes(inputProperty)) {
              throw new Error("Nested bindings cannot read write-only inputs");
            }
            return SafeExpressionEvaluator.evaluateExpression(expression[1], stepExecutionContext);
          }
          if (value.includes("${")) {
            throw new Error("Nested bindings only allow single property-path expressions");
          }
          return value;
        }
        if (Array.isArray(value)) {
          return Promise.all(value.map(evaluateBinding));
        }
        if (value && typeof value === "object") {
          return Object.fromEntries(
            await Promise.all(Object.entries(value).map(async ([name, item]) => [name, await evaluateBinding(item)])),
          );
        }
        return value;
      };
      const ordinary = await evaluateBinding(step.with || {});
      if (!ordinary || typeof ordinary !== "object" || Array.isArray(ordinary)) {
        throw new Error("Nested recipe inputs must evaluate to an object");
      }
      const resolvedInputs = { ...(ordinary as Record<string, unknown>) };
      const inputProperties = ((fn.inputs as any)?.properties || {}) as Record<string, { writeOnly?: boolean }>;
      const scopedSecrets: Record<string, string> = {};
      for (const inputName of Object.keys(resolvedInputs)) {
        if (inputProperties[inputName]?.writeOnly === true) {
          throw new Error(`Nested write-only input must use a secret mapping: ${inputName}`);
        }
      }
      for (const [alias, reference] of Object.entries(step.secrets || {})) {
        const source =
          typeof reference === "string" ? reference.match(/^\$\{secrets\.([A-Za-z_][A-Za-z0-9_]*)\}$/)?.[1] : undefined;
        if (!inputProperties[alias]?.writeOnly || !source || !Object.hasOwn(stepExecutionContext.secrets, source)) {
          throw new Error(`Invalid or unavailable nested secret mapping: ${alias}`);
        }
        const secret = stepExecutionContext.secrets[source];
        resolvedInputs[alias] = secret;
        scopedSecrets[alias] = secret;
      }
      validateRecipeInputs(fn.inputs, resolvedInputs, "with");

      const nestedSteps = fn.steps.map((nested, index) => ({
        ...nested,
        id: `${callPath}/${nested.id || `step-${index}`}`,
        name: `${step.name}/${nested.name || nested.id || `step-${index}`}`,
      }));
      callInstance.stepIds = nestedSteps.map(({ id }) => id!);
      const inputSnapshot = createStepAttemptSnapshot({
        inputs: resolvedInputs,
        priorSteps: {},
        outputs: {},
        writeOnlyInputNames: Object.keys(scopedSecrets),
      });
      callInstance.inputs = inputSnapshot.status === "captured" ? inputSnapshot.inputs || {} : {};
      const nestedContext: JobExecutionContext = {
        ...stepExecutionContext,
        inputs: ordinary as Record<string, unknown>,
        secrets: scopedSecrets,
        steps: { ...stepExecutionContext.steps },
      };
      const nestedResult = await processSteps(
        {
          ...params.processable,
          steps: nestedSteps,
          executionContext: nestedContext,
          nestedCallDepth: (params.processable.nestedCallDepth || 0) + 1,
          parentCallId: callInstance.callId,
          writeOnlyInputNames: Object.entries((fn.inputs as any)?.properties || {})
            .filter(([, schema]) => (schema as { writeOnly?: boolean }).writeOnly === true)
            .map(([name]) => name),
          workflow: params.processable.workflow ? { ...params.processable.workflow, retries: 0 } : undefined,
        },
        params.executionReport,
        params.executionReport.steps.length,
      );
      if (nestedResult.failed || nestedResult.cancelled) {
        throw new Error(`Nested recipe function failed: ${key}`);
      }

      const outputs: Record<string, unknown> = {};
      for (const [name, expression] of Object.entries(fn.returns || {})) {
        const path = expression.match(/^\$\{((?:inputs|steps|job|matrix|github)(?:\.[A-Za-z_$][\w$]*)+)\}$/)?.[1];
        if (!path) {
          throw new Error(`Unsupported nested recipe return expression: ${expression}`);
        }
        const returnedInput = path.match(/^inputs\.([A-Za-z_$][\w$]*)/)?.[1];
        if (returnedInput && inputProperties[returnedInput]?.writeOnly === true) {
          throw new Error("Nested recipe returns cannot read write-only inputs");
        }
        const localStep = path.match(/^steps\.([A-Za-z0-9_-]+)(\.|$)(.*)$/);
        const runtimePath = localStep
          ? `steps[${JSON.stringify(`${callPath}/${localStep[1]}`)}]${localStep[2]}${localStep[3]}`
          : path;
        outputs[name] = await SafeExpressionEvaluator.evaluateExpression(runtimePath, nestedContext);
      }
      validateRecipeInputs(fn.outputs, outputs, "outputs");
      const outputSnapshot = createStepAttemptSnapshot({ inputs: {}, priorSteps: {}, outputs });
      callInstance.outputs =
        outputSnapshot.status === "captured" && outputSnapshot.outputs && typeof outputSnapshot.outputs === "object"
          ? (outputSnapshot.outputs as Record<string, unknown>)
          : {};
      callInstance.status = "success";
      callInstance.durationMs = Date.now() - started;
      executionContext.steps[step.id!] = {
        status: "success",
        exitCode: 0,
        outputs,
      };
      return {
        failed: false,
        cancelled: false,
        skipped: false,
        report: {
          id: step.id!,
          name: step.name!,
          status: "success",
          durationMs: Date.now() - started,
          exitCode: 0,
          outputs,
          logContent: "",
        },
      };
    } catch (error) {
      callInstance.status = "failed";
      callInstance.durationMs = Date.now() - started;
      callInstance.error = error instanceof Error ? error.message : String(error);
      return {
        failed: true,
        cancelled: false,
        skipped: false,
        report: {
          id: step.id!,
          name: step.name!,
          status: "failed",
          durationMs: Date.now() - started,
          exitCode: 1,
          error: callInstance.error,
          outputs: {},
          logContent: "",
        },
      };
    }
  }

  if (step.dispatch) {
    const started = Date.now();
    try {
      if (!params.queue.dispatch) {
        throw new Error("Workflow dispatch requires an authenticated API runner lease");
      }
      const targetInputs =
        typeof step.with === "string"
          ? await SafeExpressionEvaluator.evaluateExpression(step.with, stepExecutionContext)
          : step.with;
      if (!targetInputs || typeof targetInputs !== "object" || Array.isArray(targetInputs)) {
        throw new Error("Dispatch inputs must evaluate to a JSON object");
      }
      const result = await params.queue.dispatch(
        params.jobId,
        step.id || `step-${stepIndex}`,
        step.dispatch,
        targetInputs,
      );
      const outputs = result && typeof result === "object" ? result : { jobId: result };
      executionContext.steps[step.id!] = {
        status: "success",
        exitCode: 0,
        outputs,
      };
      return {
        failed: false,
        cancelled: false,
        skipped: false,
        report: {
          id: step.id!,
          name: step.name!,
          status: "success",
          durationMs: Date.now() - started,
          exitCode: 0,
          outputs,
          logContent: "",
        },
      };
    } catch (error: any) {
      return {
        failed: true,
        cancelled: false,
        skipped: false,
        report: {
          id: step.id!,
          name: step.name!,
          status: "failed",
          durationMs: Date.now() - started,
          exitCode: 1,
          error: error?.message || String(error),
          outputs: {},
          logContent: "",
        },
      };
    }
  }

  try {
    const evaluatedStepEnv = await evaluateEnv(step.env, stepExecutionContext);
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
        CI: "true",
        CI_JOB_ID: String(params.jobId),
        CI_JOB_NAME: executionContext.env.CI_JOB_NAME || step.name || step.id || `step-${stepIndex}`,
      },
    };

    if (step.eval) {
      return executeEvalStep({
        ...params,
        executionContext: stepExecutionContext,
        stepContext,
      });
    } else {
      return executeRunStep({
        ...params,
        executionContext: stepExecutionContext,
        stepContext,
      });
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
        status: "failed",
        durationMs: 0,
        exitCode: 1,
        error: errorMessage,
        outputs: {},
        logContent: "",
      },
    };
  }
}

/**
 * In-Process JS `eval:` Step Execution
 */
async function executeEvalStep(params: {
  queue: WorkerExecutionQueue;
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
      timeoutTimer = setTimeout(
        () => reject(new Error(`Step timed out after ${stepContext.timeoutMs}ms`)),
        stepContext.timeoutMs,
      );
      timeoutTimer.unref();
    });
    const evalResult = await Promise.race([
      SafeExpressionEvaluator.evaluateExpression(step.eval!, executionContext),
      timeout,
    ]);

    // Store outputs in execution context for downstream steps
    executionContext.steps[stepId] = {
      status: "success",
      exitCode: 0,
      outputs: evalResult ?? {},
    };

    // Save evaluation result log to step_logs table
    const logText = typeof evalResult === "object" ? JSON.stringify(evalResult, null, 2) : String(evalResult ?? "OK");
    await queue.saveStepLog(jobId, stepId, `[JS EVAL OUTPUT]:\n${logText}`);

    console.log(`[${stepId}] ✅ JS Eval step complete.`);

    return {
      failed: false,
      cancelled: false,
      skipped: false,
      report: {
        id: stepId,
        name: stepName,
        status: "success" as const,
        durationMs: Date.now() - startTime,
        exitCode: 0,
        outputs: executionContext.steps[stepId].outputs,
        logContent: "",
      },
    };
  } catch (err: any) {
    console.error(`[${stepId}] ❌ JS Eval step failed:`, err);

    executionContext.steps[stepId] = {
      status: "failed",
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
        status: "failed" as const,
        durationMs: Date.now() - startTime,
        exitCode: 1,
        error: err.message,
        outputs: {},
        logContent: "",
      },
    };
  } finally {
    if (timeoutTimer) {
      clearTimeout(timeoutTimer);
    }
  }
}

async function evaluateEnv(env, context) {
  // Resolve entries in declaration order so later values can reference env.*.
  const evaluated: Record<string, string> = {};

  if (env) {
    for (const [key, val] of Object.entries(env)) {
      evaluated[key] = String(
        await SafeExpressionEvaluator.evaluateValue(val, {
          ...context,
          env: { ...context.env, ...evaluated },
        }),
      );
    }
  }

  return evaluated;
}

const MAX_STORED_FILE_BYTES = 50 * 1024 * 1024;

function workspacePath(workingDir: string, relativePath: string): string {
  const root = Path.resolve(workingDir);
  const target = Path.resolve(root, relativePath);
  if (target !== root && !target.startsWith(`${root}${Path.sep}`)) {
    throw new Error(`Stored file path escapes workspace: ${relativePath}`);
  }
  return target;
}

function globMatches(relativePath: string, pattern: string): boolean {
  let expression = "^";
  for (let index = 0; index < pattern.length; index++) {
    if (pattern[index] === "*" && pattern[index + 1] === "*") {
      expression += ".*";
      index++;
    } else if (pattern[index] === "*") {
      expression += "[^/]*";
    } else {
      expression += pattern[index].replace(/[|\\{}()[\]^$+?.]/g, "\\$&");
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
      if (entry.isDirectory()) {
        visit(absolute);
      } else if (entry.isFile()) {
        files.push(Path.relative(root, absolute).split(Path.sep).join("/"));
      }
    }
  };
  visit(root);
  return files.filter((file) =>
    paths.some((pattern) => {
      const target = workspacePath(workingDir, pattern);
      if (FS.existsSync(target)) {
        const stat = FS.statSync(target);
        if (stat.isFile()) {
          return file === pattern;
        }
        if (stat.isDirectory()) {
          return file === pattern || file.startsWith(`${pattern.replace(/\/$/, "")}/`);
        }
      }
      return globMatches(file, pattern);
    }),
  );
}

async function collectStoredFiles(
  paths: string[],
  workingDir: string,
): Promise<Array<{ path: string; content: string }>> {
  const files = workspaceFilesForPatterns(paths, workingDir);
  let totalBytes = 0;
  return files.map((file) => {
    const content = FS.readFileSync(workspacePath(workingDir, file));
    if (content.byteLength > MAX_STORED_FILE_BYTES || (totalBytes += content.byteLength) > MAX_STORED_FILE_BYTES) {
      throw new Error(`Stored files exceed ${MAX_STORED_FILE_BYTES} bytes`);
    }
    return { path: file, content: content.toString("base64") };
  });
}

async function restoreStoredFiles(
  queue: Pick<WorkerExecutionQueue, "getStoredFiles">,
  kind: "cache",
  ownerKey: string,
  paths: string[],
  workingDir: string,
): Promise<void> {
  for (const file of await queue.getStoredFiles(kind, ownerKey)) {
    if (
      !paths.some(
        (pattern) =>
          file.path === pattern ||
          file.path.startsWith(`${pattern.replace(/\/$/, "")}/`) ||
          globMatches(file.path, pattern),
      )
    ) {
      continue;
    }
    const target = workspacePath(workingDir, file.path);
    FS.mkdirSync(Path.dirname(target), { recursive: true });
    FS.writeFileSync(target, Buffer.from(file.content, "base64"));
  }
}

function writeSecretFiles(
  secretFiles: Record<string, string> | undefined,
  secrets: SecretStore,
  workingDir: string,
): void {
  for (const [relativePath, secretName] of Object.entries(secretFiles || {})) {
    const secret = secrets.getValue(secretName);
    if (!secret) {
      throw new Error(`Secret '${secretName}' is not available for file '${relativePath}'`);
    }
    const target = workspacePath(workingDir, relativePath);
    FS.mkdirSync(Path.dirname(target), { recursive: true });
    FS.writeFileSync(target, secret.encoding === "base64" ? Buffer.from(secret.value, "base64") : secret.value, {
      mode: 0o600,
    });
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
  queue: WorkerExecutionQueue;
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
      logFilePath: "",
    };
  }

  let cancelled = false;
  const managedHandle = {
    cancel: async () => {
      cancelled = true;
      await handle.cancel();
    },
  };
  const handles = activeStepHandles.get(String(jobId)) || new Set();
  handles.add(managedHandle);
  activeStepHandles.set(String(jobId), handles);

  const cancelCheckInterval = setInterval(async () => {
    if (await queue.isCancelled(jobId)) {
      console.log(`[${workerId}] 🛑 Job #${jobId} was cancelled! Halting execution.`);
      cancelled = true;
      clearInterval(cancelCheckInterval);
      await managedHandle.cancel();
    }
  }, 3000);

  const result: StepResult = await handle.done;
  clearInterval(cancelCheckInterval);
  handles.delete(managedHandle);
  if (!handles.size) {
    activeStepHandles.delete(String(jobId));
  }

  if (handle.logFilePath && FS.existsSync(handle.logFilePath)) {
    try {
      const logContent = await driver.readLog(handle.logFilePath);
      await queue.saveStepLog(jobId, stepId, logContent);
    } catch (logErr: any) {
      console.error(`[${workerId}] ⚠️ Failed to read step log file:`, logErr.message);
    }
  }

  const failed = result.exitCode !== 0 || cancelled;
  const stepStatus = cancelled ? "cancelled" : result.exitCode === 0 ? "success" : "failed";

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
      logContent: "",
    },
  };
}

/**
 * Fills skipped step records when execution stops early
 */
function fillSkippedSteps(steps: any[], startIndex: number, stepReports: StepReport[], reportOffset = 0) {
  for (let j = startIndex; j < steps.length; j++) {
    const skippedStep = steps[j];
    const stepId = skippedStep.id || `step-${j}`;
    stepReports[reportOffset + j] = {
      id: stepId,
      name: skippedStep.name || stepId,
      status: "skipped",
      durationMs: 0,
      exitCode: 0,
      outputs: {},
      logContent: "",
    };
  }
}

/**
 * Constructs lightweight summary execution report
 */
function buildExecutionReport(
  job: JobRecord,
  status: WorkflowExecutionReport["status"],
  startTime: number,
  inputs: Record<string, any>,
  environment: Record<string, string>,
  stepReports: StepReport[],
  payload: any,
): WorkflowExecutionReport {
  return {
    jobId: String(job.id),
    parentId: String(job.parentId || ""),
    workflowName: job.workflow_id,
    status,
    durationMs: Date.now() - startTime,
    startedAt: new Date(startTime).toISOString(),
    finishedAt: status === "running" ? undefined : new Date().toISOString(),
    inputs,
    environment,
    steps: stepReports,
    callInstances: [],
    artifacts: [],
    rerunToken: JSON.stringify({ jobId: job.id, payload }),
  };
}
