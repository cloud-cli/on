import { describe, expect, it, vi } from "vitest";
import { WebhookServer } from "./server.js";

const request = {
  teamId: "team-a",
  workflowId: "build",
  revision: 3,
  inputs: { data: { ref: "main" }, event: { id: "source-event" } },
  context: {
    eventId: "source-event",
    deliveryId: "delivery-1",
    correlationId: "correlation-1",
    causationId: null,
  },
  source: {
    eventId: "source-event",
    deliveryId: "delivery-1",
    correlationId: "correlation-1",
    causationId: null,
  },
  idempotencyKey: "domain-event-delivery:delivery-1",
};

function makeServer(existing: any = null) {
  const domainEventRepository = {
    getByIdempotencyKey: vi.fn(async () => existing),
    publish: vi.fn(async (_teamId, event) => ({ id: "invocation-event", ...event })),
  };
  const secretRepository = {
    encryptValue: vi.fn((value: string) => `ciphertext:${value}`),
    decryptValue: vi.fn((value: string) => value.replace(/^ciphertext:/, "")),
  };
  return { server: { domainEventRepository, secretRepository }, domainEventRepository, secretRepository };
}

describe("external-event workflow invocation admission", () => {
  it("publishes an encrypted, pinned request with stable cause and delivery identity", async () => {
    const { server, domainEventRepository, secretRepository } = makeServer();
    const result = await (WebhookServer.prototype as any).admitDomainEventInvocation.call(server, request);

    expect(result).toEqual({ eventId: "invocation-event", invocationId: "invocation-event" });
    expect(domainEventRepository.publish).toHaveBeenCalledWith(
      "team-a",
      expect.objectContaining({
        type: "workflow.run.requested",
        source: "domain-event-delivery/delivery-1",
        correlationId: "correlation-1",
        causationId: "source-event",
        idempotencyKey: "domain-event-delivery:delivery-1",
        data: expect.objectContaining({
          workflowId: "build",
          revision: 3,
          sourceEventId: "source-event",
          deliveryId: "delivery-1",
          inputsCiphertext: expect.stringMatching(/^ciphertext:/),
        }),
      }),
    );
    const stored = domainEventRepository.publish.mock.calls[0][1].data;
    expect(JSON.stringify(stored)).not.toContain('"ref":"main"');
    expect(secretRepository.encryptValue).toHaveBeenCalledOnce();
  });

  it("returns the original invocation on an identical delivery retry", async () => {
    const existing = {
      id: "original-invocation",
      type: "workflow.run.requested",
      source: "domain-event-delivery/delivery-1",
      data: {
        workflowId: "build",
        revision: 3,
        inputsCiphertext: `ciphertext:${JSON.stringify(request.inputs)}`,
      },
    };
    const { server, domainEventRepository } = makeServer(existing);

    await expect((WebhookServer.prototype as any).admitDomainEventInvocation.call(server, request)).resolves.toEqual({
      eventId: "original-invocation",
      invocationId: "original-invocation",
    });
    expect(domainEventRepository.publish).not.toHaveBeenCalled();
  });

  it("rejects reuse of a delivery idempotency key with conflicting inputs", async () => {
    const existing = {
      id: "original-invocation",
      type: "workflow.run.requested",
      source: "domain-event-delivery/delivery-1",
      data: {
        workflowId: "build",
        revision: 3,
        inputsCiphertext: `ciphertext:${JSON.stringify({ changed: true })}`,
      },
    };
    const { server } = makeServer(existing);

    await expect((WebhookServer.prototype as any).admitDomainEventInvocation.call(server, request)).rejects.toThrow(
      "idempotency key conflicts",
    );
  });
});
