import { describe, expect, it, vi } from "vitest";
import type { Processable, WorkflowExecutionReport } from "./types.js";
import { processJob } from "./worker.js";

describe("queued recipe pin compatibility", () => {
  it("executes an exact-main snapshot captured from a persisted legacy row", async () => {
    const legacyRow = {
      inputs_json: JSON.stringify({ type: "object", properties: {} }),
      steps_json: JSON.stringify([{ id: "legacy-body", eval: '"legacy implementation"' }]),
      functions_json: null,
    };
    // This is the compatibility snapshot produced for a pre-functions_json recipe row.
    const pinnedFunction = {
      inputs: JSON.parse(legacyRow.inputs_json),
      outputs: { type: "object" },
      steps: JSON.parse(legacyRow.steps_json),
    };
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
      workerId: "legacy-recipe-worker",
      job: {
        id: 171,
        workflow_id: "legacy-recipe",
        workflow_revision: 1,
        required_tags: "[]",
        concurrency_key: null,
        status: "running",
        worker_id: "legacy-recipe-worker",
        payload: JSON.stringify({ inputs: {} }),
        created_at: new Date().toISOString(),
      },
      queue,
      secrets: { getAll: () => ({}), redactText: (text: string) => text },
      config: { storagePath: "/tmp/legacy-recipe", serverUrl: "http://runner.test", env: {}, plugins: [] },
      driver: { execute: vi.fn(), readLog: vi.fn(async () => "") },
      workflow: {
        id: "legacy-recipe",
        name: "Legacy recipe",
        on: { provider: "generic" },
        steps: [{ id: "invoke", call: "other/legacy@7#main", with: {} }],
        _pinnedReferences: [{ namespace: "other", slug: "legacy", version: 7, function: "main" }],
        _pinnedRecipeFunctions: { "other/legacy@7#main": pinnedFunction },
      },
    } as Processable);

    const report = queue.completeJob.mock.calls[0][2] as WorkflowExecutionReport;
    expect(legacyRow.functions_json).toBeNull();
    expect(report.callInstances?.[0]).toMatchObject({ target: "other/legacy@7#main", status: "success" });
    expect(report.steps).toContainEqual(
      expect.objectContaining({
        id: "invoke#attempt-1/legacy-body",
        status: "success",
        outputs: "legacy implementation",
      }),
    );
    expect(pinnedFunction.steps).toEqual([{ id: "legacy-body", eval: '"legacy implementation"' }]);
    expect(queue.isRecipeVersionRevoked).toHaveBeenCalledWith("other", "legacy", 7);
  });

  it("executes the captured function snapshot rather than resolving the current recipe alias", async () => {
    const queue = {
      saveReport: vi.fn(async () => {}),
      saveStepLog: vi.fn(async () => {}),
      saveStepAttemptStart: vi.fn(async () => {}),
      saveStepAttempt: vi.fn(async () => {}),
      completeJob: vi.fn(async () => {}),
      isCancelled: vi.fn(async () => false),
      isRecipeVersionRevoked: vi.fn(async () => false),
    };
    const driver = { execute: vi.fn(), readLog: vi.fn(async () => "") };
    const capturedFunction = {
      inputs: { type: "object", properties: {} },
      outputs: { type: "object", properties: {} },
      steps: [{ id: "captured", eval: '"captured implementation"' }],
    };
    // The active alias now points at a different version and implementation. The queued
    // workflow carries its immutable exact target and function body from save time.
    const currentAlias = {
      version: 2,
      function: { ...capturedFunction, steps: [{ id: "changed", eval: '"new implementation"' }] },
    };

    await processJob({
      workerId: "pinned-recipe-worker",
      job: {
        id: 170,
        workflow_id: "pinned-recipe",
        workflow_revision: 1,
        required_tags: "[]",
        concurrency_key: null,
        status: "running",
        worker_id: "pinned-recipe-worker",
        payload: JSON.stringify({ inputs: {} }),
        created_at: new Date().toISOString(),
      },
      queue,
      secrets: { getAll: () => ({}), redactText: (text: string) => text },
      config: { storagePath: "/tmp/pinned-recipe", serverUrl: "http://runner.test", env: {}, plugins: [] },
      driver,
      workflow: {
        id: "pinned-recipe",
        name: "Pinned recipe",
        on: { provider: "generic" },
        steps: [{ id: "invoke", call: "team/release@1#publish", with: {} }],
        _pinnedReferences: [{ namespace: "team", slug: "release", version: 1, function: "publish" }],
        _pinnedRecipeFunctions: { "team/release@1#publish": capturedFunction },
      },
    } as Processable);

    const report = queue.completeJob.mock.calls[0][2] as WorkflowExecutionReport;
    expect(currentAlias.version).toBe(2);
    expect(report.callInstances?.[0]).toMatchObject({ target: "team/release@1#publish", status: "success" });
    expect(report.steps.map(({ id }) => id)).toContain("invoke#attempt-1/captured");
    expect(report.steps.map(({ id }) => id)).not.toContain("invoke#attempt-1/changed");
    expect(queue.isRecipeVersionRevoked).toHaveBeenCalledWith("team", "release", 1);
    expect(driver.execute).not.toHaveBeenCalled();
  });
});
