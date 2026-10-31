import { afterEach, describe, expect, it, vi } from "vitest";
import crypto from "node:crypto";
import { WebhookServer } from "./server.js";
import { GITMINI_TEMPLATE } from "./connector-templates.js";

const connector = {
  id: "normalize",
  name: "Normalize",
  workspaceId: "workspace-a",
  version: 3,
  sourceYaml: `run: |
  emit('sample.received', { value: inputs.value })
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
        "x-forwarded-for": "must-not-be-exposed",
        host: "runner.internal",
        origin: "https://untrusted.example",
        authorization: "connector-can-read-this",
      },
    })),
    incomingEvents: {
      capture: vi.fn(async () => "receipt-1"),
      receivedAtForTeam: vi.fn(async () => "2026-10-27T00:00:00.000Z"),
      finish: vi.fn(async () => {}),
    },
    domainEventRepository: {
      publish: vi.fn(async (_teamId: string, event: any) => ({ id: "event-1", type: event.type })),
    },
    domainEventDeliveryRepository: { fanout: vi.fn(async () => ({ status: "matched", deliveryCount: 1 })) },
  };
}

const response = () => ({ writeHead: vi.fn().mockReturnThis(), end: vi.fn(), headersSent: false }) as any;

afterEach(() => vi.restoreAllMocks());

describe("connector webhook ingress", () => {
  it("captures raw request, evaluates run with inputs/body/headers, and publishes emitted events", async () => {
    const server = createServer();
    const res = response();
    const sourceYaml = `run: |
  emit('sample.received', {
    value: inputs.value,
    raw: body.toString('utf8'),
    authorization: headers.authorization
  })
`;
    await (WebhookServer.prototype as any).handleConnectorWebhook.call(server, { ...connector, sourceYaml }, {}, res);

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
      idempotencyKey: "connector:normalize:delivery:delivery-1:0",
      data: { value: 7, raw: '{"value":7}', authorization: "connector-can-read-this" },
    });
    expect(server.domainEventDeliveryRepository.fanout).toHaveBeenCalledWith("workspace-a", "event-1");
    expect(server.incomingEvents.finish).toHaveBeenCalledWith("workspace-a", "receipt-1", "valid", "queued", [
      { type: "sample.received", data: { value: 7, raw: '{"value":7}', authorization: "connector-can-read-this" } },
    ]);
    expect(res.writeHead).toHaveBeenCalledWith(202, expect.any(Object));
    expect(JSON.parse(res.end.mock.calls[0][0])).toMatchObject({
      receiptId: "receipt-1",
      events: [{ id: "event-1", type: "sample.received" }],
    });
  });

  it("filters proxy, host, and origin headers from connector context while retaining other headers", async () => {
    const server = createServer();
    const res = response();
    await (WebhookServer.prototype as any).handleConnectorWebhook.call(server, connector, {}, res);

    expect(server.incomingEvents.capture.mock.calls[0][3]).not.toHaveProperty("x-forwarded-for");
    expect(server.incomingEvents.capture.mock.calls[0][3]).not.toHaveProperty("host");
    expect(server.incomingEvents.capture.mock.calls[0][3]).not.toHaveProperty("origin");
    expect(server.incomingEvents.capture.mock.calls[0][3]).toHaveProperty("authorization");
  });

  it("rejects an invalid signature in connector execution and does not publish events", async () => {
    const secret = "connector-secret";
    const rawBody = Buffer.from('{"value":7}');
    const signature = `sha256=${crypto.createHmac("sha256", secret).update(rawBody).digest("hex")}`;
    const server = createServer();
    server.readRequest.mockResolvedValue({
      rawBuffer: rawBody,
      headers: { "content-type": "application/json", "x-hook-signature": signature },
    });
    const run = `run: |
  if (!verifyBody(body, headers['x-hook-signature'])) {
    throw new Error('invalid signature')
  }
  emit('sample.received', { value: inputs.value })
`;
    const res = response();
    await (WebhookServer.prototype as any).handleConnectorWebhook.call(
      server,
      { ...connector, sourceYaml: run, signingSecret: secret },
      {},
      res,
    );

    expect(server.domainEventRepository.publish).toHaveBeenCalledOnce();
    expect(res.writeHead).toHaveBeenCalledWith(202, expect.any(Object));

    const invalid = createServer();
    invalid.readRequest.mockResolvedValue({
      rawBuffer: rawBody,
      headers: { "content-type": "application/json", "x-hook-signature": "sha256=" + "0".repeat(64) },
    });
    const invalidRes = response();
    await (WebhookServer.prototype as any).handleConnectorWebhook.call(
      invalid,
      { ...connector, sourceYaml: run, signingSecret: secret },
      {},
      invalidRes,
    );
    expect(invalid.domainEventRepository.publish).not.toHaveBeenCalled();
    expect(invalid.incomingEvents.finish).toHaveBeenCalledWith("workspace-a", "receipt-1", "valid", "failed", []);
    expect(invalidRes.writeHead).toHaveBeenCalledWith(422, expect.any(Object));
  });

  it("publishes one normalized git.push domain event per changed GitMini branch ref", async () => {
    const secret = "gitmini-secret";
    const payload = {
      id: "gitmini-delivery-1",
      org: "team",
      event: "git.push",
      action: "pushed",
      occurredAt: "2026-10-31T00:00:00.000Z",
      object: "team/service",
      details: {
        changes: [
          { ref: "refs/heads/main", before: "a".repeat(40), after: "b".repeat(40), action: "updated" },
          { ref: "refs/heads/release", before: "c".repeat(40), after: "d".repeat(40), action: "updated" },
          { ref: "refs/tags/v1", before: null, after: "e".repeat(40), action: "created" },
        ],
      },
    };
    const rawBuffer = Buffer.from(JSON.stringify(payload));
    const signature = `sha256=${crypto.createHmac("sha256", secret).update(rawBuffer).digest("hex")}`;
    const server = createServer();
    server.readRequest.mockResolvedValue({
      rawBuffer,
      headers: {
        "content-type": "application/json",
        "x-gitmini-signature": signature,
        "x-gitmini-event": "git.push",
        "x-gitmini-delivery": "gitmini-delivery-1",
      },
    });
    const res = response();
    await (WebhookServer.prototype as any).handleConnectorWebhook.call(
      server,
      { ...connector, id: "gitmini", sourceYaml: GITMINI_TEMPLATE.sourceYaml, signingSecret: secret },
      {},
      res,
    );

    expect(server.domainEventRepository.publish).toHaveBeenCalledTimes(2);
    expect(server.domainEventRepository.publish.mock.calls.map(([, event]: any[]) => event)).toEqual([
      expect.objectContaining({
        type: "git.push",
        data: expect.objectContaining({ owner: "team", repo: "service", branch: "main", commitSha: "b".repeat(40) }),
        idempotencyKey: "connector:gitmini:delivery:gitmini-delivery-1:0",
      }),
      expect.objectContaining({
        type: "git.push",
        data: expect.objectContaining({ owner: "team", repo: "service", branch: "release", commitSha: "d".repeat(40) }),
        idempotencyKey: "connector:gitmini:delivery:gitmini-delivery-1:1",
      }),
    ]);
    expect(server.domainEventDeliveryRepository.fanout).toHaveBeenCalledTimes(2);
    expect(res.writeHead).toHaveBeenCalledWith(202, expect.any(Object));
  });

  it("allows valid connectors to intentionally emit no events", async () => {
    const server = createServer();
    const res = response();
    await (WebhookServer.prototype as any).handleConnectorWebhook.call(
      server,
      { ...connector, sourceYaml: "run: |\n  if (inputs.skip) { }\n" },
      {},
      res,
    );

    expect(server.domainEventRepository.publish).not.toHaveBeenCalled();
    expect(server.incomingEvents.finish).toHaveBeenCalledWith("workspace-a", "receipt-1", "valid", "unmatched", []);
    expect(res.writeHead).toHaveBeenCalledWith(202, expect.any(Object));
  });

  it("publishes all buffered emissions in order with per-emission idempotency keys", async () => {
    const server = createServer();
    server.domainEventRepository.publish
      .mockResolvedValueOnce({ id: "event-a", type: "sample.first" })
      .mockResolvedValueOnce({ id: "event-b", type: "sample.second" });
    server.domainEventDeliveryRepository.fanout
      .mockResolvedValueOnce({ status: "matched", deliveryCount: 1 })
      .mockResolvedValueOnce({ status: "matched", deliveryCount: 2 });
    const res = response();
    const sourceYaml = `run: |
  emit('sample.first', { value: inputs.value })
  emit('sample.second', { value: inputs.value })
`;

    await (WebhookServer.prototype as any).handleConnectorWebhook.call(server, { ...connector, sourceYaml }, {}, res);

    expect(server.domainEventRepository.publish).toHaveBeenNthCalledWith(
      1,
      "workspace-a",
      expect.objectContaining({ type: "sample.first", idempotencyKey: "connector:normalize:delivery:delivery-1:0" }),
    );
    expect(server.domainEventRepository.publish).toHaveBeenNthCalledWith(
      2,
      "workspace-a",
      expect.objectContaining({ type: "sample.second", idempotencyKey: "connector:normalize:delivery:delivery-1:1" }),
    );
    expect(server.incomingEvents.finish).toHaveBeenCalledWith("workspace-a", "receipt-1", "valid", "queued", [
      { type: "sample.first", data: { value: 7 } },
      { type: "sample.second", data: { value: 7 } },
    ]);
    expect(JSON.parse(res.end.mock.calls[0][0]).events).toEqual([
      { id: "event-a", type: "sample.first" },
      { id: "event-b", type: "sample.second" },
    ]);
  });
});
