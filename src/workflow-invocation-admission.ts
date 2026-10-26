import { expandMatrix, resolveMatrixTags } from "./parser/matrix-expander.js";
import type { ParsedWorkflow } from "./types.js";

/** Immutable identity and request context shared by every variant of an invocation. */
export type WorkflowInvocationRequest = {
  invocationId: string;
  teamId: string;
  workflowId: string;
  revision: number;
  workflow: ParsedWorkflow;
  inputs: Record<string, unknown>;
  metadata?: Record<string, unknown>;
  idempotencyKeyPrefix?: string;
};

export type WorkflowInvocationVariant = {
  invocationId: string;
  teamId: string;
  workflowId: string;
  revision: number;
  index: number;
  matrix: Record<string, unknown>;
  requiredTags: string[];
  inputs: Record<string, unknown>;
  metadata: Record<string, unknown>;
  idempotencyKey: string;
};

/**
 * Build a deterministic, fully expanded admission plan. This is intentionally a
 * planning core, not durable admission: its caller must persist/recover the plan.
 */
export async function planWorkflowInvocation(request: WorkflowInvocationRequest): Promise<WorkflowInvocationVariant[]> {
  if (!request.invocationId.trim() || !request.teamId.trim() || !request.workflowId.trim()) {
    throw new Error("Invocation, team, and workflow IDs are required");
  }
  if (!Number.isInteger(request.revision) || request.revision < 1) {
    throw new Error("A pinned workflow revision is required");
  }
  const variants = expandMatrix(request.workflow);
  const planned = await Promise.all(
    variants.map(
      async (variant, index): Promise<WorkflowInvocationVariant> => ({
        invocationId: request.invocationId,
        teamId: request.teamId,
        workflowId: request.workflowId,
        revision: request.revision,
        index,
        matrix: variant.matrixContext ?? {},
        requiredTags: await resolveMatrixTags(variant.tags, variant.matrixContext, request.inputs),
        inputs: request.inputs,
        metadata: request.metadata ?? {},
        idempotencyKey: `${request.idempotencyKeyPrefix || "workflow-invocation"}:${request.invocationId}:${index}`,
      }),
    ),
  );
  return planned;
}

export type WorkflowInvocationEnqueuer = (variant: WorkflowInvocationVariant) => Promise<number | null>;

/** Enqueue all planned variants using stable queue idempotency keys. */
export async function enqueueWorkflowInvocation(
  request: WorkflowInvocationRequest,
  enqueue: WorkflowInvocationEnqueuer,
): Promise<{ plan: WorkflowInvocationVariant[]; jobIds: number[] }> {
  const plan = await planWorkflowInvocation(request);
  const jobIds: number[] = [];
  for (const variant of plan) {
    const jobId = await enqueue(variant);
    if (jobId === null) {
      throw new Error(`Workflow invocation variant ${variant.index} could not be enqueued`);
    }
    jobIds.push(jobId);
  }
  return { plan, jobIds };
}
