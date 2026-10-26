import { describe, expect, it, vi } from "vitest";
import type { Processable, WorkflowExecutionReport } from "./types.js";
import { processJob } from "./worker.js";
import { SecretStore } from "./secrets.js";

describe("incremental workflow reports", () => {
  it("does not invoke a driver when durable attempt start persistence fails", async () => {
    const queue = {
      saveReport: vi.fn(async () => {}),
      saveStepLog: vi.fn(async () => {}),
      saveStepAttemptStart: vi.fn(async () => {
        throw new Error("storage unavailable");
      }),
      completeJob: vi.fn(async () => {}),
      isCancelled: vi.fn(async () => false),
    };
    const driver = { execute: vi.fn(), readLog: vi.fn(async () => "") };
    await processJob({
      workerId: "start-failure-worker",
      job: {
        id: 126,
        workflow_id: "start-failure",
        workflow_revision: 1,
        required_tags: "[]",
        concurrency_key: null,
        status: "running",
        worker_id: "start-failure-worker",
        payload: JSON.stringify({ inputs: {} }),
        created_at: new Date().toISOString(),
      },
      queue,
      secrets: { getAll: () => ({}), redactText: (text: string) => text },
      config: { storagePath: "/tmp/start-failure", serverUrl: "http://runner.test", env: {}, plugins: [] },
      driver,
      workflow: {
        id: "start-failure",
        name: "Start failure",
        on: { provider: "generic" },
        steps: [{ id: "build", run: "true" }],
      },
    } as Processable);
    expect(driver.execute).not.toHaveBeenCalled();
    expect(queue.saveStepAttemptStart).toHaveBeenCalledTimes(1);
  });

  it("executes exact pinned nested recipe functions inline and persists their step reports", async () => {
    const queue = {
      saveReport: vi.fn(async () => {}),
      saveStepLog: vi.fn(async () => {}),
      completeJob: vi.fn(async () => {}),
      isCancelled: vi.fn(async () => false),
      isRecipeVersionRevoked: vi.fn(async () => false),
      saveStepAttempt: vi.fn(async () => {}),
      saveStepAttemptStart: vi.fn(async () => {}),
    };
    const driver = {
      execute: vi.fn(() => ({
        done: Promise.resolve({ exitCode: 0, durationMs: 1 }),
        cancel: vi.fn(),
        logFilePath: "",
      })),
      readLog: vi.fn(async () => ""),
    };
    await processJob({
      workerId: "nested-worker",
      job: {
        id: 125,
        workflow_id: "nested",
        workflow_revision: 1,
        required_tags: "[]",
        concurrency_key: null,
        status: "running",
        worker_id: "nested-worker",
        payload: JSON.stringify({ inputs: { original: "second" } }),
        created_at: new Date().toISOString(),
      },
      queue,
      secrets: { getAll: () => ({ token: "secret-value" }), redactText: (text: string) => text },
      config: {
        storagePath: "/tmp/nested-call-test",
        serverUrl: "http://runner.test",
        env: {},
        plugins: [],
      },
      driver,
      workflow: {
        id: "nested",
        name: "Nested",
        on: { provider: "generic" },
        steps: [
          {
            id: "nested-call",
            call: "team/recipe@1#main",
            with: { message: "hello" },
            secrets: { password: "${secrets.token}" },
          },
          {
            id: "second-call",
            call: "team/recipe@1#main",
            with: { message: "${inputs.original}" },
            secrets: { password: "${secrets.token}" },
          },
          { id: "consume-output", eval: "steps['nested-call'].outputs.message" },
        ],
        _pinnedReferences: [{ namespace: "team", slug: "recipe", version: 1, function: "main" }],
        _pinnedRecipeFunctions: {
          "team/recipe@1#main": {
            inputs: {
              type: "object",
              properties: { message: { type: "string" }, password: { type: "string", writeOnly: true } },
              required: ["message", "password"],
              additionalProperties: false,
            },
            outputs: {
              type: "object",
              properties: { message: { type: "string" } },
              required: ["message"],
              additionalProperties: false,
            },
            returns: { message: "${steps.main.outputs}" },
            steps: [
              { id: "secret-check", eval: "secrets.password.length" },
              { id: "main", eval: "inputs.message" },
            ],
          },
        },
      } as Processable,
    } as Processable);

    expect(queue.isRecipeVersionRevoked).toHaveBeenCalledWith("team", "recipe", 1);
    expect(driver.execute).not.toHaveBeenCalled();
    expect(queue.completeJob.mock.calls[0][1]).toBe("success");
    expect(queue.completeJob.mock.calls[0][2].steps[0].status).toBe("success");
    expect(queue.completeJob.mock.calls[0][2].steps[2]).toMatchObject({
      id: "consume-output",
      status: "success",
      outputs: "hello",
    });
    expect(queue.completeJob.mock.calls[0][2].steps[1].outputs).toEqual({ message: "second" });
    expect(queue.completeJob.mock.calls[0][2].steps[3]).toMatchObject({
      id: "nested-call#attempt-1/secret-check",
      status: "success",
      outputs: 12,
    });
    expect(queue.completeJob.mock.calls[0][2].steps[4]).toMatchObject({
      id: "nested-call#attempt-1/main",
      status: "success",
    });
    expect(queue.completeJob.mock.calls[0][2].steps[5]).toMatchObject({
      id: "second-call#attempt-1/secret-check",
      status: "success",
    });
    expect(queue.completeJob.mock.calls[0][2].steps[6]).toMatchObject({
      id: "second-call#attempt-1/main",
      status: "success",
    });
    expect(JSON.stringify(queue.completeJob.mock.calls[0][2])).not.toContain("secret-value");
    expect(queue.saveStepAttemptStart).toHaveBeenCalledWith(
      expect.objectContaining({ stepId: "nested-call#attempt-1/main" }),
    );
    expect(queue.saveStepAttemptStart).toHaveBeenCalledWith(
      expect.objectContaining({ stepId: "second-call#attempt-1/main" }),
    );
  });

  it.each([
    ["revoked", true, { "team/recipe@1#main": { inputs: {}, outputs: { type: "object" }, steps: [] } }],
    ["missing pinned snapshot", false, {}],
  ])("fails nested calls closed for %s dependencies", async (_label, revoked, pinned) => {
    const queue = {
      saveReport: vi.fn(async () => {}),
      saveStepLog: vi.fn(async () => {}),
      saveStepAttemptStart: vi.fn(async () => {}),
      saveStepAttempt: vi.fn(async () => {}),
      completeJob: vi.fn(async () => {}),
      isCancelled: vi.fn(async () => false),
      isRecipeVersionRevoked: vi.fn(async () => revoked),
    };
    const driver = { execute: vi.fn(), readLog: vi.fn(async () => "") };
    await processJob({
      workerId: "invalid-nested-worker",
      job: {
        id: 127,
        workflow_id: "nested-invalid",
        workflow_revision: 1,
        required_tags: "[]",
        concurrency_key: null,
        status: "running",
        worker_id: "invalid-nested-worker",
        payload: JSON.stringify({ inputs: {} }),
        created_at: new Date().toISOString(),
      },
      queue,
      secrets: { getAll: () => ({}), redactText: (text: string) => text },
      config: { storagePath: "/tmp/nested-invalid", serverUrl: "http://runner.test", env: {}, plugins: [] },
      driver,
      workflow: {
        id: "nested-invalid",
        name: "Nested invalid",
        on: { provider: "generic" },
        steps: [{ id: "call", call: "team/recipe@1#main", with: {} }],
        _pinnedReferences: [{ namespace: "team", slug: "recipe", version: 1, function: "main" }],
        _pinnedRecipeFunctions: pinned,
      },
    } as Processable);

    expect(driver.execute).not.toHaveBeenCalled();
    expect(queue.completeJob.mock.calls[0][1]).toBe("failed");
    expect(queue.completeJob.mock.calls[0][2].steps[0].status).toBe("failed");
  });

  it("requires the nested target to be in the captured exact pin set", async () => {
    const queue = {
      saveReport: vi.fn(async () => {}),
      saveStepLog: vi.fn(async () => {}),
      saveStepAttemptStart: vi.fn(async () => {}),
      saveStepAttempt: vi.fn(async () => {}),
      completeJob: vi.fn(async () => {}),
      isCancelled: vi.fn(async () => false),
      isRecipeVersionRevoked: vi.fn(async () => false),
    };
    await processJob({
      workerId: "unpinned-worker",
      job: {
        id: 131,
        workflow_id: "unpinned",
        workflow_revision: 1,
        required_tags: "[]",
        concurrency_key: null,
        status: "running",
        worker_id: "unpinned-worker",
        payload: JSON.stringify({ inputs: {} }),
        created_at: new Date().toISOString(),
      },
      queue,
      secrets: { getAll: () => ({}), redactText: (text: string) => text },
      config: { storagePath: "/tmp/unpinned", serverUrl: "http://runner.test", env: {}, plugins: [] },
      driver: { execute: vi.fn(), readLog: vi.fn(async () => "") },
      workflow: {
        id: "unpinned",
        name: "Unpinned",
        on: { provider: "generic" },
        steps: [{ id: "call", call: "team/recipe@1#main", with: {} }],
        _pinnedReferences: [],
        _pinnedRecipeFunctions: { "team/recipe@1#main": { inputs: {}, outputs: { type: "object" }, steps: [] } },
      },
    } as Processable);
    expect(queue.isRecipeVersionRevoked).toHaveBeenCalledWith("team", "recipe", 1);
    expect(queue.completeJob.mock.calls[0][1]).toBe("failed");
    expect(queue.completeJob.mock.calls[0][2].steps[0].status).toBe("failed");
  });

  it("evaluates typed recipe bindings and exposes only explicitly mapped recipe secrets", async () => {
    const queue = {
      saveReport: vi.fn(async () => {}),
      saveStepLog: vi.fn(async () => {}),
      completeJob: vi.fn(async () => {}),
      isCancelled: vi.fn(async () => false),
      saveStepAttemptStart: vi.fn(async () => {}),
      saveStepAttempt: vi.fn(async () => {}),
      saveStepAttemptStart: vi.fn(async () => {}),
    };
    const driver = {
      execute: vi.fn(() => ({
        done: Promise.resolve({ exitCode: 0, durationMs: 1 }),
        cancel: vi.fn(),
        logFilePath: "",
      })),
      readLog: vi.fn(async () => ""),
    };
    await processJob({
      workerId: "recipe-worker",
      job: {
        id: 124,
        workflow_id: "recipe",
        workflow_revision: 1,
        required_tags: "[]",
        concurrency_key: null,
        status: "running",
        worker_id: "recipe-worker",
        payload: JSON.stringify({ inputs: { count: 3 } }),
        created_at: new Date().toISOString(),
      },
      queue,
      secrets: {
        getAll: () => ({
          DEPLOY_TOKEN: "mapped-value",
          OTHER_TOKEN: "unmapped-value",
        }),
        redactText: (text: string) => text,
      },
      config: {
        storagePath: "/tmp",
        serverUrl: "http://runner.test",
        env: {},
        plugins: [],
      },
      driver,
      workflow: {
        id: "recipe",
        name: "Recipe",
        on: { provider: "generic" },
        steps: [
          {
            id: "recipe-step",
            run: 'echo "$COUNT" "$TOKEN"',
            env: { COUNT: "${inputs.count}", TOKEN: "${secrets.token}" },
            __recipeTemplate: true,
          },
        ],
        _recipeInputs: { count: "${inputs.count}" },
        _recipeInputSchema: {
          type: "object",
          required: ["count"],
          properties: { count: { type: "integer" } },
          additionalProperties: false,
        },
        _recipeSecrets: { token: "DEPLOY_TOKEN" },
      },
    } as Processable);

    expect(driver.execute.mock.calls[0][0].command).toBe('echo "$COUNT" "$TOKEN"');
    expect(driver.execute.mock.calls[0][0].env).toMatchObject({
      COUNT: "3",
      TOKEN: "mapped-value",
    });
    expect(driver.execute.mock.calls[0][0].env).not.toHaveProperty("OTHER_TOKEN");
    const report = queue.completeJob.mock.calls[0][2];
    expect(JSON.stringify(report)).not.toContain("mapped-value");
    expect(JSON.stringify(report)).not.toContain("unmapped-value");
  });

  it("isolates workspace paths by lease identity and keeps each lease path stable", async () => {
    const workspaceDirs: string[] = [];
    const makeRun = async (executionId: string) => {
      const queue = {
        saveReport: vi.fn(async () => {}),
        saveStepLog: vi.fn(async () => {}),
        completeJob: vi.fn(async () => {}),
        isCancelled: vi.fn(async () => false),
        saveStepAttemptStart: vi.fn(async () => {}),
      };
      const driver = {
        execute: vi.fn((context: any) => {
          workspaceDirs.push(context.workingDir);
          return {
            done: Promise.resolve({ exitCode: 0, durationMs: 1 }),
            cancel: vi.fn(),
            logFilePath: "",
          };
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
        config: {
          storagePath: "/tmp/workspace-test",
          serverUrl: "http://runner.test",
          env: {},
          plugins: [],
        },
        driver,
        workflow: {
          id: "lease",
          name: "Lease",
          on: { provider: "generic" },
          steps: [{ id: "main", run: "echo ok" }],
        },
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
      saveStepAttemptStart: vi.fn(async () => {}),
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
      config: {
        storagePath: "/tmp",
        serverUrl: "http://runner.test",
        env: {},
        plugins: [],
      },
      driver,
      workflow: {
        id: "post-success",
        name: "Post success",
        on: { provider: "generic" },
        steps: [{ id: "main", eval: "({ ok: true })" }],
        post: [
          { id: "status-failure", run: "false" },
          {
            id: "observe-result",
            eval: "({ status: job.status, envStatus: env.CI_JOB_STATUS, runUrl: job.runUrl })",
          },
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
      saveStepAttemptStart: vi.fn(async () => {}),
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
      config: {
        storagePath: "/tmp",
        serverUrl: "http://runner.test",
        env: {},
        plugins: [],
      },
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
          {
            id: "observe-result",
            eval: "({ status: job.status, envStatus: env.CI_JOB_STATUS, runUrl: job.runUrl })",
          },
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
    const dispatch = vi.fn(async () => ({
      jobId: 91,
      workflowId: "downstream",
      parentId: 9,
    }));
    const queue = {
      saveReport: vi.fn(async () => {}),
      saveStepLog: vi.fn(async () => {}),
      completeJob: vi.fn(async () => {}),
      isCancelled: vi.fn(async () => false),
      saveStepAttemptStart: vi.fn(async () => {}),
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
      config: {
        storagePath: "/tmp",
        serverUrl: "http://runner.test",
        env: {},
        plugins: [],
      },
      driver: {},
      workflow: {
        id: "intake",
        name: "Intake",
        on: { provider: "alias" },
        steps: [
          {
            id: "normalize",
            eval: '({ repository: "org/repo", labels: ["main"] })',
          },
          {
            id: "handoff",
            dispatch: "downstream",
            with: "steps.normalize.outputs",
          },
        ],
      },
    } as Processable);
    expect(dispatch).toHaveBeenCalledWith(9, "handoff", "downstream", {
      repository: "org/repo",
      labels: ["main"],
    });
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
      saveStepAttemptStart: vi.fn(async () => {}),
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
      config: {
        storagePath: "/tmp",
        serverUrl: "http://runner.test",
        env: {},
        plugins: [],
      },
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
      {
        image: "example",
        tag: "example:latest",
        ci: "true",
        job: "1",
        name: "Incremental",
      },
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
    const order: string[] = [];
    const queue = {
      saveReport: vi.fn(async () => {}),
      saveStepLog: vi.fn(async () => {}),
      completeJob: vi.fn(async () => {}),
      isCancelled: vi.fn(async () => false),
      saveStepAttemptStart: vi.fn(async () => {}),
      saveStepAttempt: vi.fn(async () => {}),
      saveStepAttemptStart: vi.fn(async () => {
        order.push("start");
      }),
    };
    const driver = {
      execute: vi.fn(() => {
        order.push("driver");
        return {
          done: Promise.resolve({
            exitCode: ++attempts === 2 ? 0 : 1,
            durationMs: 1,
          }),
          cancel: async () => {},
          logFilePath: "",
        };
      }),
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
      config: {
        storagePath: "/tmp",
        serverUrl: "http://runner.test",
        env: {},
        plugins: [],
      },
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
    expect(order).toEqual(["start", "driver", "start", "driver"]);
    expect(queue.completeJob).toHaveBeenCalledWith(2, "success", expect.any(Object));
    expect(queue.saveStepAttempt.mock.calls.map(([record]) => [record.attempt, record.status])).toEqual([
      [1, "failed"],
      [2, "success"],
    ]);
  });

  it("redacts secret values before persisting captured step logs", async () => {
    const logs: string[] = [];
    const reports: WorkflowExecutionReport[] = [];
    const queue = {
      saveReport: vi.fn(async (_jobId: string | number, report: WorkflowExecutionReport) => reports.push(report)),
      saveStepLog: vi.fn(async (_jobId: string | number, _stepId: string, content: string) => logs.push(content)),
      completeJob: vi.fn(async () => {}),
      isCancelled: vi.fn(async () => false),
      saveStepAttemptStart: vi.fn(async () => {}),
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
      config: {
        storagePath: "/tmp",
        serverUrl: "http://runner.test",
        env: {},
        plugins: [],
      },
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

  it.each([
    [
      "invalid nested input",
      {
        inputs: { type: "object", properties: { count: { type: "integer" } }, required: ["count"] },
        outputs: { type: "object" },
      },
      {},
      { count: "wrong" },
      undefined,
    ],
    [
      "invalid output schema",
      { inputs: { type: "object" }, outputs: { type: "not-a-json-schema-type" }, with: {}, returns: {} },
      {},
      undefined,
      {},
    ],
    [
      "invalid returned value",
      {
        inputs: { type: "object" },
        outputs: { type: "object", properties: { count: { type: "integer" } }, required: ["count"] },
        with: {},
        returns: { count: "${inputs.value}" },
      },
      { value: "not-an-integer" },
      undefined,
      undefined,
    ],
    [
      "malformed return expression",
      { inputs: { type: "object" }, outputs: { type: "object" }, with: {}, returns: { value: "${inputs.value + 1}" } },
      { value: 1 },
      undefined,
      undefined,
    ],
    [
      "unsupported binding expression",
      {
        inputs: { type: "object", properties: { value: { type: "string" } }, required: ["value"] },
        outputs: { type: "object" },
        with: { value: "prefix-${inputs.value}" },
        returns: {},
      },
      { value: "x" },
      undefined,
      undefined,
    ],
  ])("fails closed for %s", async (_label, fn, callerInputs, withInputs, returns) => {
    const queue = {
      saveReport: vi.fn(async () => {}),
      saveStepLog: vi.fn(async () => {}),
      saveStepAttemptStart: vi.fn(async () => {}),
      saveStepAttempt: vi.fn(async () => {}),
      completeJob: vi.fn(async () => {}),
      isCancelled: vi.fn(async () => false),
      isRecipeVersionRevoked: vi.fn(async () => false),
    };
    const pinnedFn = { ...fn, ...(returns !== undefined ? { returns } : {}) };
    await processJob({
      workerId: "nested-validation",
      job: {
        id: 128,
        workflow_id: "nested-validation",
        workflow_revision: 1,
        required_tags: "[]",
        concurrency_key: null,
        status: "running",
        worker_id: "nested-validation",
        payload: JSON.stringify({ inputs: callerInputs }),
        created_at: new Date().toISOString(),
      },
      queue,
      secrets: { getAll: () => ({}), redactText: (text: string) => text },
      config: { storagePath: "/tmp/nested-validation", serverUrl: "http://runner.test", env: {}, plugins: [] },
      driver: { execute: vi.fn(), readLog: vi.fn(async () => "") },
      workflow: {
        id: "nested-validation",
        name: "Nested validation",
        on: { provider: "generic" },
        steps: [{ id: "invoke", call: "team/recipe@1#main", with: withInputs ?? fn.with }],
        _pinnedReferences: [{ namespace: "team", slug: "recipe", version: 1, function: "main" }],
        _pinnedRecipeFunctions: { "team/recipe@1#main": { ...pinnedFn, steps: [{ id: "noop", eval: "true" }] } },
      },
    } as Processable);
    expect(queue.completeJob.mock.calls[0][1]).toBe("failed");
    expect(queue.completeJob.mock.calls[0][2].steps[0].status).toBe("failed");
  });

  it.each([
    ["non-writeOnly input", { ordinary: "${secrets.token}" }, { token: "caller-secret" }],
    ["unmapped caller secret", { password: "${secrets.missing}" }, { token: "caller-secret" }],
  ])("rejects nested secret mapping failure: %s", async (_label, secretsMap, suppliedSecrets) => {
    const queue = {
      saveReport: vi.fn(async () => {}),
      saveStepLog: vi.fn(async () => {}),
      saveStepAttemptStart: vi.fn(async () => {}),
      saveStepAttempt: vi.fn(async () => {}),
      completeJob: vi.fn(async () => {}),
      isCancelled: vi.fn(async () => false),
      isRecipeVersionRevoked: vi.fn(async () => false),
    };
    await processJob({
      workerId: "nested-secret",
      job: {
        id: 129,
        workflow_id: "nested-secret",
        workflow_revision: 1,
        required_tags: "[]",
        concurrency_key: null,
        status: "running",
        worker_id: "nested-secret",
        payload: JSON.stringify({ inputs: {} }),
        created_at: new Date().toISOString(),
      },
      queue,
      secrets: { getAll: () => suppliedSecrets, redactText: (text: string) => text },
      config: { storagePath: "/tmp/nested-secret", serverUrl: "http://runner.test", env: {}, plugins: [] },
      driver: { execute: vi.fn(), readLog: vi.fn(async () => "") },
      workflow: {
        id: "nested-secret",
        name: "Nested secret",
        on: { provider: "generic" },
        steps: [{ id: "invoke", call: "team/recipe@1#main", with: {}, secrets: secretsMap }],
        _pinnedReferences: [{ namespace: "team", slug: "recipe", version: 1, function: "main" }],
        _pinnedRecipeFunctions: {
          "team/recipe@1#main": {
            inputs: {
              type: "object",
              properties: { ordinary: { type: "string" }, password: { type: "string", writeOnly: true } },
            },
            outputs: { type: "object" },
            steps: [],
          },
        },
      },
    } as Processable);
    expect(queue.completeJob.mock.calls[0][1]).toBe("failed");
    expect(JSON.stringify(queue.completeJob.mock.calls[0][2])).not.toContain("caller-secret");
  });

  it("retries a failed nested call under parent policy with distinct nested attempts and redacted persistence", async () => {
    const secret = "nested-private-value";
    const reports: WorkflowExecutionReport[] = [];
    const logs: string[] = [];
    const attempts: any[] = [];
    const queue = {
      saveReport: vi.fn(async (_id, report: WorkflowExecutionReport) => reports.push(structuredClone(report))),
      saveStepLog: vi.fn(async (_id, _step, content: string) => logs.push(content)),
      saveStepAttemptStart: vi.fn(async () => {}),
      saveStepAttempt: vi.fn(async (record: any) => attempts.push(record)),
      completeJob: vi.fn(async (_id, _status, report: WorkflowExecutionReport) =>
        reports.push(structuredClone(report)),
      ),
      isCancelled: vi.fn(async () => false),
      isRecipeVersionRevoked: vi.fn(async () => false),
    };
    let executions = 0;
    const driver = {
      execute: vi.fn(() => ({
        done: Promise.resolve({ exitCode: ++executions === 1 ? 1 : 0, durationMs: 1 }),
        cancel: vi.fn(),
        logFilePath: "/etc/hosts",
      })),
      readLog: vi.fn(async () => `diagnostic ${secret}`),
    };
    await processJob({
      workerId: "nested-retry",
      job: {
        id: 130,
        workflow_id: "nested-retry",
        workflow_revision: 1,
        required_tags: "[]",
        concurrency_key: null,
        status: "running",
        worker_id: "nested-retry",
        payload: JSON.stringify({ inputs: {} }),
        created_at: new Date().toISOString(),
      },
      queue,
      secrets: { getAll: () => ({ TOKEN: secret }), redactText: (text: string) => text.split(secret).join("****") },
      config: { storagePath: "/tmp/nested-retry", serverUrl: "http://runner.test", env: {}, plugins: [] },
      driver,
      workflow: {
        id: "nested-retry",
        name: "Nested retry",
        on: { provider: "generic" },
        retries: 1,
        steps: [{ id: "invoke", call: "team/recipe@1#main", with: {}, secrets: { password: "${secrets.TOKEN}" } }],
        _pinnedReferences: [{ namespace: "team", slug: "recipe", version: 1, function: "main" }],
        _pinnedRecipeFunctions: {
          "team/recipe@1#main": {
            inputs: {
              type: "object",
              properties: { password: { type: "string", writeOnly: true } },
              required: ["password"],
            },
            outputs: { type: "object" },
            steps: [{ id: "effect", run: "emit diagnostic" }],
          },
        },
      },
    } as Processable);
    expect(queue.isRecipeVersionRevoked).toHaveBeenCalledWith("team", "recipe", 1);
    expect(driver.execute).toHaveBeenCalledTimes(2);
    expect(
      attempts
        .filter(({ stepId }) => stepId.includes("/effect"))
        .map(({ stepId, attempt, status }) => [stepId, attempt, status]),
    ).toEqual([
      ["invoke#attempt-1/effect", 1, "failed"],
      ["invoke#attempt-2/effect", 1, "success"],
    ]);
    const final = queue.completeJob.mock.calls[0][2] as WorkflowExecutionReport;
    expect(queue.completeJob.mock.calls[0][1]).toBe("success");
    expect(final.steps.map(({ id }) => id)).toContain("invoke#attempt-1/effect");
    expect(final.steps.map(({ id }) => id)).toContain("invoke#attempt-2/effect");
    expect(JSON.stringify({ reports, logs, attempts, final })).not.toContain(secret);
    expect(attempts.every(({ snapshotJson }) => typeof snapshotJson === "string")).toBe(true);
    expect(JSON.stringify(attempts.map(({ snapshotJson }) => JSON.parse(snapshotJson)))).not.toContain("password");
    expect(JSON.stringify(attempts)).not.toContain(secret);
    expect(logs).toHaveLength(2);
    expect(logs.every((log) => log.includes("****"))).toBe(true);
  });
});
