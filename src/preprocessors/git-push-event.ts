export function createGitPushEvent(input: {
  provider: string;
  deliveryId?: string;
  occurredAt?: unknown;
  receivedAt: string;
  repository: string;
  owner?: string;
  name?: string;
  ref: string;
  commit: string;
  deleted?: boolean;
}) {
  if (!input.repository || !input.commit || !Number.isFinite(Date.parse(input.receivedAt))) {
    return null;
  }
  const parsedOccurredAt = typeof input.occurredAt === "string" ? Date.parse(input.occurredAt) : Number.NaN;
  const deliveryId = input.deliveryId || null;
  return {
    type: "git.push",
    schemaVersion: 1,
    source: `connector/${input.provider}`,
    occurredAt: Number.isFinite(parsedOccurredAt) ? new Date(parsedOccurredAt).toISOString() : input.receivedAt,
    correlationId: null,
    causationId: deliveryId,
    idempotencyKey: deliveryId ? `${input.provider}:delivery:${deliveryId}` : null,
    data: {
      repository: input.repository,
      ...(input.owner ? { owner: input.owner } : {}),
      ...(input.name ? { name: input.name } : {}),
      ref: input.ref,
      commit: input.commit,
      operation: input.deleted ? "delete" : "push",
    },
  };
}
