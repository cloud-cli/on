import { afterEach, describe, expect, it, vi } from "vitest";
import { WebhookServer } from "./server.js";
import crypto from "node:crypto";

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

  it("validates timestamped HMAC over exact raw body before capturing a receipt", async () => {
    const secret = "signing-secret";
    const rawBody = Buffer.from('{"value":7}');
    const timestamp = String(Math.floor(Date.now() / 1000));
    const signature = crypto
      .createHmac("sha256", secret)
      .update(timestamp + ".")
      .update(rawBody)
      .digest("hex");
    const server = createServer();
    server.readRequest.mockResolvedValue({
      rawBuffer: rawBody,
      headers: {
        "content-type": "application/json",
        "x-connector-timestamp": timestamp,
        "x-connector-signature": `sha256=${signature}`,
      },
    });
    const res = response();
    await (WebhookServer.prototype as any).handleConnectorWebhook.call(
      server,
      { ...connector, signingSecret: secret },
      {},
      res,
    );
    expect(server.incomingEvents.capture).toHaveBeenCalledOnce();
    const capturedHeaders = server.incomingEvents.capture.mock.calls[0][3];
    expect(capturedHeaders).not.toHaveProperty("x-connector-timestamp");
    expect(capturedHeaders).not.toHaveProperty("x-connector-signature");
    expect(res.writeHead).toHaveBeenCalledWith(202, expect.any(Object));
  });

  it("accepts GitHub's native HMAC-SHA256 webhook signature over exact raw bytes", async () => {
    const secret = "github-signing-secret";
    const rawBody = Buffer.from('{ "value":7 }');
    const signature = crypto.createHmac("sha256", secret).update(rawBody).digest("hex");
    const server = createServer();
    server.readRequest.mockResolvedValue({
      rawBuffer: rawBody,
      headers: { "content-type": "application/json", "x-hub-signature-256": `sha256=${signature}` },
    });
    const res = response();
    await (WebhookServer.prototype as any).handleConnectorWebhook.call(
      server,
      { ...connector, signingSecret: secret },
      {},
      res,
    );

    expect(server.incomingEvents.capture).toHaveBeenCalledOnce();
    expect(server.incomingEvents.capture.mock.calls[0][3]).not.toHaveProperty("x-hub-signature-256");
    expect(res.writeHead).toHaveBeenCalledWith(202, expect.any(Object));
  });

  it("rejects a GitHub signature when raw request bytes change", async () => {
    const secret = "github-signing-secret";
    const signedBody = Buffer.from('{"value":7}');
    const signature = crypto.createHmac("sha256", secret).update(signedBody).digest("hex");
    const server = createServer();
    server.readRequest.mockResolvedValue({
      rawBuffer: Buffer.from('{ "value":7 }'),
      headers: { "content-type": "application/json", "x-hub-signature-256": `sha256=${signature}` },
    });
    const res = response();
    await (WebhookServer.prototype as any).handleConnectorWebhook.call(
      server,
      { ...connector, signingSecret: secret },
      {},
      res,
    );

    expect(res.writeHead).toHaveBeenCalledWith(401, expect.any(Object));
    expect(server.incomingEvents.capture).not.toHaveBeenCalled();
  });

  it.each(["missing", "invalid", "stale"])("rejects %s signature before receipt capture", async (caseName) => {
    const secret = "signing-secret";
    const rawBody = Buffer.from('{"value":7}');
    const timestamp = String(Math.floor(Date.now() / 1000) - (caseName === "stale" ? 301 : 0));
    const signature = caseName === "invalid" ? "sha256=" + "0".repeat(64) : "";
    const server = createServer();
    server.readRequest.mockResolvedValue({
      rawBuffer: rawBody,
      headers: {
        "content-type": "application/json",
        ...(caseName === "missing" ? {} : { "x-connector-timestamp": timestamp }),
        ...(caseName === "invalid"
          ? { "x-connector-signature": signature }
          : caseName === "stale"
            ? {
                "x-connector-signature": `sha256=${crypto
                  .createHmac("sha256", secret)
                  .update(timestamp + ".")
                  .update(rawBody)
                  .digest("hex")}`,
              }
            : {}),
      },
    });
    const res = response();
    await (WebhookServer.prototype as any).handleConnectorWebhook.call(
      server,
      { ...connector, signingSecret: secret },
      {},
      res,
    );
    expect(res.writeHead).toHaveBeenCalledWith(401, expect.any(Object));
    expect(server.incomingEvents.capture).not.toHaveBeenCalled();
  });
});
