import { describe, expect, it, vi } from "vitest";
import type { Processable, WorkflowExecutionReport } from "./types.js";
import { processJob } from "./worker.js";
import { SecretStore } from "./secrets.js";

describe("incremental workflow reports", () => {
  it("isolates workspace paths by lease identity and keeps each lease path stable", async () => {
    const workspaceDirs: string[] = [];
    const makeRun = async (executionId: string) => {
      const queue = {
        saveReport: vi.fn(async () => {}),
        saveStepLog: vi.fn(async () => {}),
        completeJob: vi.fn(async () => {}),
        isCancelled: vi.fn(async () => false),
      };
      const driver = {
        execute: vi.fn((context: any) => {
          workspaceDirs.push(context.workingDir);
          return { done: Promise.resolve({ exitCode: 0, durationMs: 1 }), cancel: vi.fn(), logFilePath: "" };
        }),
        readLog: vi.fn(async () => ""),
      };
      await processJob({
        executionId,
        workerId: "lease-worker",
        job: {
          id: 123,
          workflow_id: "lease",
          workflow_revision: 1,
          required_tags: "[]",
          concurrency_key: null,
          status: "running",
          worker_id: "lease-worker",
          payload: JSON.stringify({ inputs: {} }),
          created_at: new Date().toISOString(),
        },
        queue,
        secrets: { getAll: () => ({}), redactText: (text: string) => text },
        config: { storagePath: "/tmp/workspace-test", serverUrl: "http://runner.test", env: {}, plugins: [] },
        driver,
        workflow: { id: "lease", name: "Lease", on: { provider: "generic" }, steps: [{ id: "main", run: "echo ok" }] },
      } as Processable);
    };
    await makeRun("lease-one");
    await makeRun("lease-two");
    await makeRun("lease-one");
    expect(workspaceDirs[0]).not.toBe(workspaceDirs[1]);
    expect(workspaceDirs[0]).toBe(workspaceDirs[2]);
    expect(workspaceDirs[0]).toContain("execution-");
  });

  it("runs post steps after success and keeps post failures non-fatal", async () => {
    const queue = {
      saveReport: vi.fn(async () => {}),
      saveStepLog: vi.fn(async () => {}),
      completeJob: vi.fn(async () => {}),
      isCancelled: vi.fn(async () => false),
    };
    const driver = {
      execute: vi.fn(() => ({
        done: Promise.resolve({ exitCode: 1, durationMs: 1 }),
        cancel: vi.fn(async () => {}),
        logFilePath: "",
      })),
      readLog: vi.fn(async () => "status request failed"),
    };
    await processJob({
      workerId: "post-worker",
      job: {
        id: 20,
        workflow_id: "post-success",
        workflow_revision: 1,
        required_tags: "[]",
        concurrency_key: null,
        status: "running",
        worker_id: "post-worker",
        payload: JSON.stringify({ inputs: {} }),
        created_at: new Date().toISOString(),
      },
      queue,
      secrets: { getAll: () => ({}), redactText: (text: string) => text },
      config: { storagePath: "/tmp", serverUrl: "http://runner.test", env: {}, plugins: [] },
      driver,
      workflow: {
        id: "post-success",
        name: "Post success",
        on: { provider: "generic" },
        steps: [{ id: "main", eval: "({ ok: true })" }],
        post: [
          { id: "status-failure", run: "false" },
          { id: "observe-result", eval: "({ status: job.status, envStatus: env.CI_JOB_STATUS, runUrl: job.runUrl })" },
        ],
      },
    } as Processable);

    const report = queue.completeJob.mock.calls[0][2];
    expect(queue.completeJob).toHaveBeenCalledWith(20, "success", expect.any(Object));
    expect(report.steps.map((step: any) => step.status)).toEqual(["success", "failed", "success"]);
    expect(report.steps[2].outputs).toEqual({
      status: "success",
      envStatus: "success",
      runUrl: "http://runner.test/ui/runs/20",
    });
  });

  it("runs post steps after a failed main step with the terminal status", async () => {
    const queue = {
      saveReport: vi.fn(async () => {}),
      saveStepLog: vi.fn(async () => {}),
      completeJob: vi.fn(async () => {}),
      isCancelled: vi.fn(async () => false),
    };
    const driver = {
      execute: vi.fn(() => ({
        done: Promise.resolve({ exitCode: 1, durationMs: 1 }),
        cancel: vi.fn(async () => {}),
        logFilePath: "",
      })),
      readLog: vi.fn(async () => "main task failed"),
    };
    await processJob({
      workerId: "post-worker",
      job: {
        id: 21,
        workflow_id: "post-failure",
        workflow_revision: 1,
        required_tags: "[]",
        concurrency_key: null,
        status: "running",
        worker_id: "post-worker",
        payload: JSON.stringify({ inputs: {} }),
        created_at: new Date().toISOString(),
      },
      queue,
      secrets: { getAll: () => ({}), redactText: (text: string) => text },
      config: { storagePath: "/tmp", serverUrl: "http://runner.test", env: {}, plugins: [] },
      driver,
      workflow: {
        id: "post-failure",
        name: "Post failure",
        on: { provider: "generic" },
        steps: [
          { id: "main", run: "false" },
          { id: "not-run", run: "true" },
        ],
        post: [
          { id: "observe-result", eval: "({ status: job.status, envStatus: env.CI_JOB_STATUS, runUrl: job.runUrl })" },
        ],
      },
    } as Processable);

    const report = queue.completeJob.mock.calls[0][2];
    expect(queue.completeJob).toHaveBeenCalledWith(21, "failed", expect.any(Object));
    expect(report.steps.map((step: any) => step.status)).toEqual(["failed", "skipped", "success"]);
    expect(report.steps[2].outputs).toEqual({
      status: "failed",
      envStatus: "failed",
      runUrl: "http://runner.test/ui/runs/21",
    });
  });

  it("hands structured step outputs to an authenticated dispatch queue", async () => {
    const dispatch = vi.fn(async () => ({ jobId: 91, workflowId: "downstream", parentId: 9 }));
    const queue = {
      saveReport: vi.fn(async () => {}),
      saveStepLog: vi.fn(async () => {}),
      completeJob: vi.fn(async () => {}),
      isCancelled: vi.fn(async () => false),
      dispatch,
    };
    await processJob({
      workerId: "test-worker",
      job: {
        id: 9,
        workflow_id: "intake",
        workflow_revision: 1,
        required_tags: "[]",
        concurrency_key: null,
        status: "running",
        worker_id: "test-worker",
        payload: JSON.stringify({ inputs: {} }),
        created_at: new Date().toISOString(),
      },
      queue,
      secrets: { getAll: () => ({}), redactText: (text: string) => text },
      config: { storagePath: "/tmp", serverUrl: "http://runner.test", env: {}, plugins: [] },
      driver: {},
      workflow: {
        id: "intake",
        name: "Intake",
        on: { provider: "alias" },
        steps: [
          { id: "normalize", eval: '({ repository: "org/repo", labels: ["main"] })' },
          { id: "handoff", dispatch: "downstream", with: "steps.normalize.outputs" },
        ],
      },
    } as Processable);
    expect(dispatch).toHaveBeenCalledWith(9, "handoff", "downstream", { repository: "org/repo", labels: ["main"] });
  });

  it("persists every step transition and output", async () => {
    const reports: WorkflowExecutionReport[] = [];
    const logs: Array<{ stepId: string; content: string }> = [];
    const queue = {
      saveReport: vi.fn(async (_jobId, report: WorkflowExecutionReport) => {
        reports.push(structuredClone(report));
      }),
      saveStepLog: vi.fn(async (_jobId, stepId: string, content: string) => {
        logs.push({ stepId, content });
      }),
      completeJob: vi.fn(async (_jobId, _status, report: WorkflowExecutionReport) => {
        reports.push(structuredClone(report));
      }),
      isCancelled: vi.fn(async () => false),
    };
    const payload = {
      inputs: { repo: "example" },
    };
    const workflow = {
      id: "incremental",
      name: "Incremental",
      on: { provider: "generic" },
      env: {
        image: "${inputs.repo}",
        image_tag: "${env.image}:latest",
      },
      steps: [
        {
          id: "first",
          eval: "({ image: env.image, tag: env.image_tag, ci: env.CI, job: env.CI_JOB_ID, name: env.CI_JOB_NAME })",
        },
        { id: "second", eval: "({ value: 2 })" },
      ],
    };

    await processJob({
      workerId: "test-worker",
      job: {
        id: 1,
        workflow_id: "incremental",
        workflow_revision: 1,
        required_tags: "[]",
        concurrency_key: null,
        status: "running",
        worker_id: "test-worker",
        payload: JSON.stringify(payload),
        created_at: new Date().toISOString(),
      },
      queue,
      secrets: { getAll: () => ({}), redactText: (text: string) => text },
      config: { storagePath: "/tmp", serverUrl: "http://runner.test", env: {}, plugins: [] },
      driver: {},
      workflow,
    } as Processable);

    expect(reports.map((report) => report.steps.map((step) => step.status))).toEqual([
      ["pending", "pending"],
      ["pending", "pending"],
      ["running", "pending"],
      ["success", "pending"],
      ["success", "running"],
      ["success", "success"],
      ["success", "success"],
    ]);
    expect(reports.at(-1)?.steps.map((step) => step.outputs)).toEqual([
      { image: "example", tag: "example:latest", ci: "true", job: "1", name: "Incremental" },
      { value: 2 },
    ]);
    expect(logs).toEqual([
      {
        stepId: "first",
        content:
          '[JS EVAL OUTPUT]:\n{\n  "image": "example",\n  "tag": "example:latest",\n  "ci": "true",\n  "job": "1",\n  "name": "Incremental"\n}',
      },
      { stepId: "second", content: '[JS EVAL OUTPUT]:\n{\n  "value": 2\n}' },
    ]);
    expect(queue.completeJob).toHaveBeenCalledWith(1, "success", expect.any(Object));
  });

  it("retries failed steps according to the workflow setting", async () => {
    let attempts = 0;
    const queue = {
      saveReport: vi.fn(async () => {}),
      saveStepLog: vi.fn(async () => {}),
      completeJob: vi.fn(async () => {}),
      isCancelled: vi.fn(async () => false),
    };
    const driver = {
      execute: vi.fn(() => ({
        done: Promise.resolve({ exitCode: ++attempts === 2 ? 0 : 1, durationMs: 1 }),
        cancel: async () => {},
        logFilePath: "",
      })),
      readLog: vi.fn(async () => ""),
    };

    await processJob({
      workerId: "test-worker",
      job: {
        id: 2,
        workflow_id: "retry-workflow",
        workflow_revision: 1,
        required_tags: "[]",
        concurrency_key: null,
        status: "running",
        worker_id: "test-worker",
        payload: JSON.stringify({ inputs: {} }),
        created_at: new Date().toISOString(),
      },
      queue,
      secrets: { getAll: () => ({}), redactText: (text: string) => text },
      config: { storagePath: "/tmp", serverUrl: "http://runner.test", env: {}, plugins: [] },
      driver,
      workflow: {
        id: "retry-workflow",
        name: "Retry workflow",
        on: { provider: "generic" },
        retries: 1,
        steps: [{ id: "retry", run: "false" }],
      },
    } as Processable);

    expect(driver.execute).toHaveBeenCalledTimes(2);
    expect(queue.completeJob).toHaveBeenCalledWith(2, "success", expect.any(Object));
  });

  it("redacts secret values before persisting captured step logs", async () => {
    const logs: string[] = [];
    const reports: WorkflowExecutionReport[] = [];
    const queue = {
      saveReport: vi.fn(async (_jobId: string | number, report: WorkflowExecutionReport) => reports.push(report)),
      saveStepLog: vi.fn(async (_jobId: string | number, _stepId: string, content: string) => logs.push(content)),
      completeJob: vi.fn(async () => {}),
      isCancelled: vi.fn(async () => false),
    };
    const secrets = new SecretStore();
    secrets.replace({ DEPLOY_TOKEN: "sensitive-token-value" });
    expect(secrets.redactText("sensitive-token-value")).toBe("****");
    const redactSpy = vi.spyOn(secrets, "redactText");

    await processJob({
      workerId: "test-worker",
      job: {
        id: 4,
        workflow_id: "redaction-workflow",
        workflow_revision: 1,
        required_tags: "[]",
        concurrency_key: null,
        status: "running",
        worker_id: "test-worker",
        payload: JSON.stringify({ inputs: {} }),
        created_at: new Date().toISOString(),
      },
      queue,
      secrets,
      config: { storagePath: "/tmp", serverUrl: "http://runner.test", env: {}, plugins: [] },
      driver: {},
      workflow: {
        id: "redaction-workflow",
        name: "Redaction workflow",
        on: { provider: "generic" },
        steps: [{ id: "emit", eval: '({ token: "sensitive-token-value" })' }],
      },
    } as Processable);

    expect(logs).toHaveLength(1);
    expect(redactSpy).toHaveBeenCalled();
    expect(logs[0]).not.toContain("sensitive-token-value");
    expect(logs[0]).toContain("****");
    expect(JSON.stringify(reports)).not.toContain("sensitive-token-value");
    expect(JSON.stringify(reports)).toContain("****");
  });
});
