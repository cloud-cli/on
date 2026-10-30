import { afterEach, describe, expect, it, vi } from "vitest";
import { WebhookServer } from "./server.js";

const connector = {
  id: "normalize",
  name: "Normalize",
  workspaceId: "workspace-a",
  version: 3,
  sourceYaml: `kind: connector
id: normalize
name: Normalize
steps:
  - id: map
    eval: "({ type: 'sample.received', data: { value: body.value } })"
`,
};

function createServer() {
  return {
    workflowsLoaded: Promise.resolve(),
    readRequest: vi.fn(async () => ({
      rawBuffer: Buffer.from('{"value":7}'),
      headers: {
        "content-type": "application/json",
        "x-delivery-id": "delivery-1",
        authorization: "must-not-be-persisted",
      },
    })),
    incomingEvents: {
      capture: vi.fn(async () => "receipt-1"),
      receivedAtForTeam: vi.fn(async () => "2026-10-27T00:00:00.000Z"),
      finish: vi.fn(async () => {}),
    },
    domainEventRepository: { publish: vi.fn(async () => ({ id: "event-1", type: "sample.received" })) },
    domainEventDeliveryRepository: { fanout: vi.fn(async () => ({ status: "matched", deliveryCount: 1 })) },
  };
}

const response = () => ({ writeHead: vi.fn().mockReturnThis(), end: vi.fn(), headersSent: false }) as any;

afterEach(() => vi.restoreAllMocks());

describe("connector webhook ingress", () => {
  it("captures receipt, evaluates the connector, and publishes a durable typed event", async () => {
    const server = createServer();
    const res = response();
    await (WebhookServer.prototype as any).handleConnectorWebhook.call(server, connector, {}, res);

    expect(server.incomingEvents.capture).toHaveBeenCalledWith(
      "workspace-a",
      "normalize",
      3,
      expect.objectContaining({ "content-type": "application/json", "x-delivery-id": "delivery-1" }),
      Buffer.from('{"value":7}'),
    );
    expect(server.domainEventRepository.publish).toHaveBeenCalledWith("workspace-a", {
      type: "sample.received",
      schemaVersion: 1,
      source: "connector/normalize",
      occurredAt: "2026-10-27T00:00:00.000Z",
      correlationId: null,
      causationId: "receipt-1",
      idempotencyKey: "connector:normalize:delivery:delivery-1",
      data: { value: 7 },
    });
    expect(server.domainEventDeliveryRepository.fanout).toHaveBeenCalledWith("workspace-a", "event-1");
    expect(server.incomingEvents.finish).toHaveBeenCalledWith("workspace-a", "receipt-1", "valid", "queued", {
      type: "sample.received",
      data: { value: 7 },
    });
    expect(res.writeHead).toHaveBeenCalledWith(202, expect.any(Object));
    expect(JSON.parse(res.end.mock.calls[0][0])).toMatchObject({ receiptId: "receipt-1", eventId: "event-1" });
  });

  it("fails closed when a connector document is invalid", async () => {
    const server = createServer();
    vi.spyOn(console, "error").mockImplementation(() => {});
    const res = response();
    await (WebhookServer.prototype as any).handleConnectorWebhook.call(
      server,
      { ...connector, sourceYaml: "kind: connector\nid: normalize\nname: Normalize\nsteps: [{run: 'true'}]" },
      {},
      res,
    );

    expect(server.domainEventRepository.publish).not.toHaveBeenCalled();
    expect(server.incomingEvents.finish).toHaveBeenCalledWith("workspace-a", "receipt-1", "valid", "failed", null);
    expect(res.writeHead).toHaveBeenCalledWith(422, expect.any(Object));
    expect(JSON.stringify(res.end.mock.calls)).not.toContain("run: 'true'");
  });
});
