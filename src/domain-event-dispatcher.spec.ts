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
  const enqueue = vi.fn(async ({ idempotencyKey }: { idempotencyKey: string }) =>
    idempotencyKey.endsWith(":0") ? 10 : 11,
  );
  const deps = {
    events: { getForTeam: vi.fn(async () => event) },
    subscriptions: { getForTeam: vi.fn(async () => subscription) },
    deliveries: { finish },
    resolveWorkflow: vi.fn(async () => workflow),
    enqueue,
    ...overrides,
  };
  return {
    dispatcher: new DomainEventDispatcher(deps as never),
    finish,
    enqueue,
    deps,
  };
}

describe("DomainEventDispatcher", () => {
  it("enqueues every matrix variant with event data and source metadata", async () => {
    const { dispatcher, enqueue, finish } = setup();
    await dispatcher.process(delivery);
    expect(enqueue).toHaveBeenCalledTimes(2);
    expect(enqueue.mock.calls.map(([call]) => call.idempotencyKey)).toEqual([
      "domain-event:delivery-1:0",
      "domain-event:delivery-1:1",
    ]);
    expect(enqueue.mock.calls[0][0].payload.inputs).toMatchObject({
      data: { foo: "bar", event: "user" },
      event: { source: "tests", id: "event-1" },
    });
    expect(finish).toHaveBeenCalledWith("team-1", "delivery-1", 3, {
      status: "admitted",
      jobIds: ["10", "11"],
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
    expect(missing.enqueue).not.toHaveBeenCalled();
  });

  it("retries after partial matrix admission without duplicating variants", async () => {
    const persisted = new Map<string, number>();
    let failSecondVariant = true;
    const enqueue = vi.fn(async ({ idempotencyKey }: { idempotencyKey: string }) => {
      if (idempotencyKey.endsWith(":1") && failSecondVariant) {
        failSecondVariant = false;
        throw new Error("temporary failure after first variant persisted");
      }
      const existing = persisted.get(idempotencyKey);
      if (existing !== undefined) {
        return existing;
      }
      const id = idempotencyKey.endsWith(":0") ? 10 : 11;
      persisted.set(idempotencyKey, id);
      return id;
    });
    const partial = setup({ enqueue });
    await partial.dispatcher.process(delivery);
    expect(persisted).toEqual(new Map([["domain-event:delivery-1:0", 10]]));
    expect(partial.finish).toHaveBeenCalledWith(
      "team-1",
      "delivery-1",
      3,
      expect.objectContaining({ status: "pending" }),
    );
    const retry = setup();
    retry.enqueue.mockImplementation(enqueue);
    await retry.dispatcher.process({ ...delivery, attemptCount: 4 });
    expect(retry.enqueue.mock.calls.map(([call]) => call.idempotencyKey)).toEqual([
      "domain-event:delivery-1:0",
      "domain-event:delivery-1:1",
    ]);
    expect(retry.finish).toHaveBeenCalledWith("team-1", "delivery-1", 4, expect.anything());
    expect(persisted).toEqual(
      new Map([
        ["domain-event:delivery-1:0", 10],
        ["domain-event:delivery-1:1", 11],
      ]),
    );
    expect(enqueue).toHaveBeenCalledTimes(4);
    expect(retry.finish.mock.calls[0][3]).toMatchObject({ status: "admitted", jobIds: ["10", "11"] });
  });
});
