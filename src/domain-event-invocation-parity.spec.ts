import { describe, expect, it, vi } from "vitest";
import { DomainEventDispatcher } from "./domain-event-dispatcher.js";
import { WebhookServer } from "./server.js";

describe("durable delivery invocation outcome semantics", () => {
  it("treats duplicate delivery admission as the same accepted request, not workflow completion", async () => {
    const invocationEvents = new Map<string, any>();
    let eventSequence = 0;
    const domainEventRepository = {
      getByIdempotencyKey: vi.fn(async (_teamId: string, key: string) => invocationEvents.get(key) ?? null),
      publish: vi.fn(async (_teamId: string, input: any) => {
        const event = { id: `request-${++eventSequence}`, ...input };
        invocationEvents.set(input.idempotencyKey, event);
        return event;
      }),
    };
    const server = {
      domainEventRepository,
      secretRepository: {
        encryptValue: (value: string) => `encrypted:${value}`,
        decryptValue: (value: string) => value.replace(/^encrypted:/, ""),
      },
    };
    const finish = vi.fn(async () => null);
    const dispatcher = new DomainEventDispatcher({
      events: {
        getForTeam: async () => ({
          id: "source-event",
          teamId: "team-a",
          type: "push",
          schemaVersion: 1,
          source: "test",
          occurredAt: "now",
          recordedAt: "now",
          correlationId: "correlation-a",
          causationId: null,
          idempotencyKey: null,
          data: { branch: "main" },
        }),
      },
      subscriptions: {
        getForTeam: async () => ({
          id: "subscription-a",
          teamId: "team-a",
          workflowId: "build",
          workflowRevision: 3,
          eventType: "push",
          enabled: true,
          createdAt: "now",
        }),
      },
      deliveries: { finish },
      resolveWorkflow: async () => ({ id: "build", steps: [] }) as any,
      admitInvocation: (request) => (WebhookServer.prototype as any).admitDomainEventInvocation.call(server, request),
    });
    const delivery = {
      id: "delivery-a",
      teamId: "team-a",
      eventId: "source-event",
      subscriptionId: "subscription-a",
      status: "claimed" as const,
      attemptCount: 1,
      leaseUntil: null,
      jobIds: [],
      lastError: null,
      createdAt: "now",
      updatedAt: "now",
    };

    await dispatcher.process(delivery);
    const firstFinish = finish.mock.calls[0][3];
    expect(firstFinish).toMatchObject({ status: "admitted", invocationId: expect.any(String) });
    expect(firstFinish.status).not.toBe("completed");
    expect(domainEventRepository.publish).toHaveBeenCalledOnce();

    await dispatcher.process({ ...delivery, attemptCount: 2 });
    expect(finish.mock.calls[1][3]).toEqual(firstFinish);
    expect(domainEventRepository.publish).toHaveBeenCalledOnce();
    expect(invocationEvents.size).toBe(1);
  });

  it("records a filtered delivery without invoking or publishing a workflow request", async () => {
    const admitInvocation = vi.fn();
    const finish = vi.fn(async () => null);
    const dispatcher = new DomainEventDispatcher({
      events: { getForTeam: async () => ({ id: "source-event", teamId: "team-a" }) as any },
      subscriptions: {
        getForTeam: async () => ({ id: "subscription-a", teamId: "team-a", workflowId: "build" }) as any,
      },
      deliveries: { finish },
      resolveWorkflow: async () => ({ id: "build" }) as any,
      matches: () => false,
      admitInvocation,
    });

    await dispatcher.process({
      id: "delivery-a",
      teamId: "team-a",
      eventId: "source-event",
      subscriptionId: "subscription-a",
      status: "claimed",
      attemptCount: 1,
      leaseUntil: null,
      jobIds: [],
      lastError: null,
      createdAt: "now",
      updatedAt: "now",
    });

    expect(finish).toHaveBeenCalledWith("team-a", "delivery-a", 1, { status: "filtered" });
    expect(admitInvocation).not.toHaveBeenCalled();
  });
});
