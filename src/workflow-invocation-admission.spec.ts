import { describe, expect, it, vi } from "vitest";
import { enqueueWorkflowInvocation, planWorkflowInvocation } from "./workflow-invocation-admission.js";
import type { ParsedWorkflow } from "./types.js";

const workflow = {
  id: "build",
  name: "Build",
  matrix: { node: [18, 20] },
  tags: ["${matrix.node}", "docker"],
  steps: [],
} as unknown as ParsedWorkflow;

const request = {
  invocationId: "invoke-stable",
  teamId: "team-a",
  workflowId: "build",
  revision: 4,
  workflow,
  inputs: { source: "push" },
  metadata: { eventId: "event-a" },
};

describe("workflow invocation admission planning", () => {
  it("creates deterministic pinned variants and stable idempotency keys", async () => {
    const first = await planWorkflowInvocation(request);
    const second = await planWorkflowInvocation(request);
    expect(first).toEqual(second);
    expect(
      first.map(({ index, matrix, requiredTags, idempotencyKey }) => ({
        index,
        matrix,
        requiredTags,
        idempotencyKey,
      })),
    ).toEqual([
      {
        index: 0,
        matrix: { node: 18 },
        requiredTags: ["18", "docker"],
        idempotencyKey: "workflow-invocation:invoke-stable:0",
      },
      {
        index: 1,
        matrix: { node: 20 },
        requiredTags: ["20", "docker"],
        idempotencyKey: "workflow-invocation:invoke-stable:1",
      },
    ]);
    expect(first[0]).toMatchObject({
      teamId: "team-a",
      workflowId: "build",
      revision: 4,
      inputs: request.inputs,
      metadata: request.metadata,
    });
  });

  it("enqueues variants in plan order and fails when one cannot be enqueued", async () => {
    const enqueue = vi.fn().mockResolvedValueOnce(10).mockResolvedValueOnce(11);
    await expect(enqueueWorkflowInvocation(request, enqueue)).resolves.toMatchObject({ jobIds: [10, 11] });
    expect(enqueue.mock.calls.map(([variant]) => variant.idempotencyKey)).toEqual([
      "workflow-invocation:invoke-stable:0",
      "workflow-invocation:invoke-stable:1",
    ]);
    await expect(enqueueWorkflowInvocation(request, vi.fn().mockResolvedValue(null))).rejects.toThrow("variant 0");
  });

  it("rejects missing stable identity or invalid pinned revision", async () => {
    await expect(planWorkflowInvocation({ ...request, invocationId: " " })).rejects.toThrow("IDs are required");
    await expect(planWorkflowInvocation({ ...request, revision: 0 })).rejects.toThrow("pinned workflow revision");
  });
});
