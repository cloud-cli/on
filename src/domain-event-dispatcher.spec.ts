import { describe, expect, it, vi } from "vitest";
import { DomainEventDispatcher } from "./domain-event-dispatcher.js";
import type { DomainEvent } from "./domain-event-repository.js";
import type { EventDelivery, EventSubscription } from "./domain-event-delivery-repository.js";
import type { ParsedWorkflow } from "./types.js";

const delivery: EventDelivery = {
  id: "delivery-1",
  teamId: "team-1",
  eventId: "event-1",
  subscriptionId: "sub-1",
  status: "claimed",
  attemptCount: 3,
  leaseUntil: null,
  jobIds: [],
  lastError: null,
  createdAt: "now",
  updatedAt: "now",
};
const event: DomainEvent = {
  id: "event-1",
  teamId: "team-1",
  type: "build",
  schemaVersion: 1,
  source: "tests",
  occurredAt: "now",
  recordedAt: "now",
  correlationId: "corr",
  causationId: null,
  idempotencyKey: null,
  data: { foo: "bar", event: "user" },
};
const subscription: EventSubscription = {
  id: "sub-1",
  teamId: "team-1",
  workflowId: "workflow-1",
  workflowRevision: 4,
  eventType: "build",
  enabled: true,
  createdAt: "now",
};
const workflow = {
  name: "build",
  steps: [],
  matrix: { node: [18, 20] },
} as unknown as ParsedWorkflow;

function setup(overrides: Record<string, unknown> = {}) {
  const finish = vi.fn(async () => null);
  const admitInvocation = vi.fn(async ({ idempotencyKey }: { idempotencyKey: string }) => ({
    eventId: `run-event:${idempotencyKey}`,
    invocationId: `invocation:${idempotencyKey}`,
  }));
  const deps = {
    events: { getForTeam: vi.fn(async () => event) },
    subscriptions: { getForTeam: vi.fn(async () => subscription) },
    deliveries: { finish },
    resolveWorkflow: vi.fn(async () => workflow),
    admitInvocation,
    ...overrides,
  };
  return {
    dispatcher: new DomainEventDispatcher(deps as never),
    finish,
    admitInvocation: deps.admitInvocation as typeof admitInvocation,
    deps,
  };
}

describe("DomainEventDispatcher", () => {
  it("durably admits one invocation with event data, source metadata, and stable delivery identity", async () => {
    const { dispatcher, admitInvocation, finish } = setup();
    await dispatcher.process(delivery);
    expect(admitInvocation).toHaveBeenCalledTimes(1);
    expect(admitInvocation.mock.calls[0][0]).toMatchObject({
      teamId: "team-1",
      workflowId: "workflow-1",
      revision: 4,
      idempotencyKey: "domain-event-delivery:delivery-1",
      context: {
        eventId: "event-1",
        deliveryId: "delivery-1",
        correlationId: "corr",
        causationId: null,
      },
      source: {
        eventId: "event-1",
        deliveryId: "delivery-1",
        correlationId: "corr",
        causationId: null,
      },
    });
    expect(admitInvocation.mock.calls[0][0].inputs).toMatchObject({
      data: { foo: "bar", event: "user" },
      event: { source: "tests", id: "event-1" },
    });
    expect(finish).toHaveBeenCalledWith("team-1", "delivery-1", 3, {
      status: "admitted",
      invocationId: "invocation:domain-event-delivery:delivery-1",
    });
  });

  it("filters matches and fails unavailable pinned revisions", async () => {
    const filtered = setup({ matches: () => false });
    await filtered.dispatcher.process(delivery);
    expect(filtered.finish).toHaveBeenCalledWith("team-1", "delivery-1", 3, {
      status: "filtered",
    });
    const missing = setup({ resolveWorkflow: async () => null });
    await missing.dispatcher.process(delivery);
    expect(missing.finish.mock.calls[0][3]).toMatchObject({ status: "failed" });
    expect(missing.admitInvocation).not.toHaveBeenCalled();
  });

  it("retries after partial matrix admission without duplicating variants", async () => {
    const persisted = new Map<string, string>();
    let failSecondVariant = true;
    const admitInvocation = vi.fn(async ({ idempotencyKey }: { idempotencyKey: string }) => {
      if (failSecondVariant) {
        failSecondVariant = false;
        throw new Error("temporary admission failure");
      }
      const existing = persisted.get(idempotencyKey);
      if (existing !== undefined) {
        return { eventId: `event:${existing}`, invocationId: existing };
      }
      const id = "invocation-1";
      persisted.set(idempotencyKey, id);
      return { eventId: "run-event-1", invocationId: id };
    });
    const partial = setup({ admitInvocation });
    await partial.dispatcher.process(delivery);
    expect(persisted).toEqual(new Map());
    expect(partial.finish).toHaveBeenCalledWith(
      "team-1",
      "delivery-1",
      3,
      expect.objectContaining({ status: "pending" }),
    );
    const retry = setup({ admitInvocation });
    await retry.dispatcher.process({ ...delivery, attemptCount: 4 });
    expect(retry.admitInvocation.mock.calls.at(-1)?.[0].idempotencyKey).toBe("domain-event-delivery:delivery-1");
    expect(retry.finish).toHaveBeenCalledWith("team-1", "delivery-1", 4, expect.anything());
    expect(persisted).toEqual(new Map([["domain-event-delivery:delivery-1", "invocation-1"]]));
    expect(admitInvocation).toHaveBeenCalledTimes(2);
    expect(retry.finish.mock.calls[0][3]).toMatchObject({
      status: "admitted",
      invocationId: "invocation-1",
    });
  });
});
