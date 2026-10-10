import { homedir } from "node:os";
import { join } from "node:path";
import { resolveDriver } from "./drivers/index.js";
import { RunnerApi, type RunnerLease } from "./runner-api.js";
import { RunnerApiClient } from "./runner-api-client.js";
import { enrollRunner, readRunnerCredential, writeRunnerCredential } from "./runner-credentials.js";
import { SecretStore } from "./secrets.js";
import { abortActiveJob, shutdownState } from "./worker.js";
import type { JobRecord, RunnerConfig, WorkflowExecutionReport, WorkerExecutionQueue } from "./types.js";
import { applyRunnerUpdate, runnerUpdateCapabilities } from "./runner-updater.js";
import { RUNNER_VERSION } from "./version.js";

const delay = (milliseconds: number, signal?: AbortSignal) =>
  new Promise<void>((resolve) => {
    if (signal?.aborted) return resolve();
    const timer = setTimeout(resolve, milliseconds);
    timer.unref();
    signal?.addEventListener(
      "abort",
      () => {
        clearTimeout(timer);
        resolve();
      },
      { once: true },
    );
  });

export async function startApiWorkers(config: RunnerConfig): Promise<void> {
  const credentialPath =
    config.runnerCredentialPath ||
    process.env.RUNNER_CREDENTIAL_FILE ||
    join(homedir(), ".config/on/runner-credential");
  let credential = config.runnerCredential || (await readRunnerCredential(credentialPath));
  if (!credential && config.runnerEnrollCode) {
    const issued = await enrollRunner(
      config.serverUrl,
      config.runnerEnrollCode,
      process.env.RUNNER_NAME || "node-runner",
      "node",
      fetch,
    );
    credential = issued.credential;
    await writeRunnerCredential(credentialPath, credential);
    console.log(
      `Runner enrolled (${issued.runnerId}); credential saved with owner-only permissions at ${credentialPath}`,
    );
  }
  if (!credential) throw new Error("Set RUNNER_CREDENTIAL or provide RUNNER_ENROLLMENT_CODE for one-time enrollment");

  const api = new RunnerApi(config.serverUrl, credential);
  const eventsClient = new RunnerApiClient(config.serverUrl, credential);
  const controller = new AbortController();
  const activeJobs = new Set<Promise<void>>();
  const applyingUpdates = new Set<string>();
  const concurrency = Math.max(1, Math.min(100, Math.trunc(config.workers || 1)));
  let wake: (() => void) | undefined;
  const signalWake = () => wake?.();
  const reconcileUpdate = async () => {
    try {
      const update = await api.pendingUpdate();
      if (update) await applyUpdate(update);
    } catch (error) {
      console.error("Runner update reconciliation failed:", error);
    }
  };
  const applyUpdate = async (update: { id: string; version: string }) => {
    if (!update.id || applyingUpdates.has(update.id)) return;
    applyingUpdates.add(update.id);
    let restartScheduled = false;
    try {
      await applyRunnerUpdate(update.version, config);
      restartScheduled = true;
      console.info(
        `Runner update ${update.id} scheduled for version ${update.version}; awaiting new-version heartbeat.`,
      );
    } catch (error) {
      console.error(`Runner update ${update.id} failed:`, error);
      await api.reportUpdate(update.id, "failed").catch((reportError) => {
        console.error("Unable to report runner update failure:", reportError);
      });
    } finally {
      if (!restartScheduled) applyingUpdates.delete(update.id);
    }
  };
  const events = (async () => {
    let backoff = 1000;
    while (!controller.signal.aborted) {
      try {
        for await (const event of eventsClient.events(controller.signal)) {
          if (event.event === "runner.update") {
            // Treat SSE as a wake-up only; authenticated REST is authoritative.
            void reconcileUpdate();
          }
          if (
            event.event === "lease.cancelled" &&
            (typeof event.data.jobId === "string" || typeof event.data.jobId === "number")
          ) {
            void abortActiveJob(event.data.jobId);
          }
          if (event.event === "jobs.available" || event.event === "lease.cancelled" || event.event === "runner.drain")
            signalWake();
        }
        backoff = 1000;
      } catch (error) {
        if (controller.signal.aborted) break;
        console.error("Runner event stream disconnected; REST polling will continue:", error);
      }
      await delay(backoff, controller.signal);
      backoff = Math.min(30_000, backoff * 2);
      signalWake();
    }
  })();
  const sendHeartbeat = () =>
    api.heartbeat({
      version: RUNNER_VERSION,
      runtime: "node",
      capabilities: [...new Set([...config.tags, ...runnerUpdateCapabilities(config)])],
      concurrency,
      activeJobs: activeJobs.size,
    });
  await sendHeartbeat();
  await reconcileUpdate();
  const heartbeat = setInterval(() => {
    void sendHeartbeat()
      .then(reconcileUpdate)
      .catch((error) => console.error("Runner heartbeat failed:", error));
  }, 15_000);
  heartbeat.unref();
  const stop = () => {
    shutdownState.isStopping = true;
    controller.abort();
    signalWake();
  };
  process.once("SIGINT", stop);
  process.once("SIGTERM", stop);
  shutdownState.isStopping = false;
  console.log(`API-only runner started. Concurrency: ${config.workers}; labels: ${config.tags.join(", ") || "(none)"}`);
  signalWake();

  try {
    while (!shutdownState.isStopping) {
      while (activeJobs.size < concurrency && !shutdownState.isStopping) {
        try {
          const lease = await api.claim(config.tags);
          if (!lease) break;
          let task: Promise<void>;
          task = executeLease(api, lease, config)
            .catch((error) => {
              console.error(`Runner job ${lease.job.id} failed:`, error);
              // It may have started side effects. Let the lease expire rather than
              // immediately requeueing and risking duplicate execution.
            })
            .finally(() => {
              activeJobs.delete(task);
              signalWake();
            });
          activeJobs.add(task);
        } catch (error) {
          console.error("Runner claim failed; retrying after backoff:", error);
          await delay(3000, controller.signal);
          break;
        }
      }
      if (!shutdownState.isStopping && activeJobs.size >= concurrency) {
        await new Promise<void>((resolve) => {
          const timer = setTimeout(resolve, 30_000);
          wake = () => {
            clearTimeout(timer);
            resolve();
          };
        });
        wake = undefined;
      } else if (!shutdownState.isStopping) {
        await new Promise<void>((resolve) => {
          const timer = setTimeout(resolve, 3000);
          wake = () => {
            clearTimeout(timer);
            resolve();
          };
        });
        wake = undefined;
      }
    }
  } finally {
    controller.abort();
    clearInterval(heartbeat);
    await Promise.allSettled(activeJobs);
    await events;
    process.removeListener("SIGINT", stop);
    process.removeListener("SIGTERM", stop);
  }
}

async function executeLease(api: RunnerApi, lease: RunnerLease, config: RunnerConfig) {
  const job = lease.job as unknown as JobRecord;
  const workflow = lease.workflow as any;
  const secrets = new SecretStore();
  secrets.replace(await api.secrets(lease));
  const queue = createLeaseQueue(api, lease, job);
  let leaseLost = false;
  const renew = setInterval(() => {
    void api.renew(lease).catch((error) => {
      leaseLost = true;
      console.error(`Lease ${lease.leaseId} renewal failed; cancelling job ${job.id}:`, error);
      void abortActiveJob(job.id);
    });
  }, 30_000);
  renew.unref();
  try {
    const driver = await resolveDriver();
    const { processJob } = await import("./worker.js");
    await processJob({
      workerId: config.runnerId || "node-runner",
      job,
      queue,
      secrets,
      config,
      driver,
      workflow,
    });
    if (leaseLost) throw new Error("Runner lease renewal failed; execution is fenced");
  } finally {
    clearInterval(renew);
  }
}

function createLeaseQueue(api: RunnerApi, lease: RunnerLease, job: JobRecord): WorkerExecutionQueue {
  let cancelled = false;
  return {
    async saveReport(jobId: string | number, report: WorkflowExecutionReport) {
      await api.report(lease, { ...report, jobId, status: report.status });
    },
    async completeJob(jobId: string | number, status: string, report: WorkflowExecutionReport) {
      await api.complete(lease, jobId, status, report);
    },
    async saveStepLog(jobId: string | number, stepId: string, content: string) {
      await api.log(lease, jobId, stepId, content);
    },
    async saveStoredFiles(
      kind: "artifact" | "cache",
      ownerKey: string,
      files: Array<{ path: string; content: string }>,
    ) {
      await api.files(lease, kind, "save", ownerKey, files);
    },
    async getStoredFiles(kind: "artifact" | "cache", ownerKey: string) {
      const result = await api.files(lease, kind, "load", ownerKey, []);
      return Array.isArray(result?.files) ? result.files : [];
    },
    async isCancelled() {
      if (cancelled) return true;
      try {
        const state = await api.state(lease);
        cancelled = state.status !== "running" || String(state.jobId) !== String(job.id);
      } catch {
        cancelled = true;
      }
      return cancelled;
    },
  };
}
