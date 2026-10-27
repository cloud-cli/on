import { beforeEach, describe, expect, it, vi } from "vitest";

const database = vi.hoisted(() => ({ get: vi.fn() }));
vi.mock("./db-client.js", () => ({ default: database }));

import { WebhookServer } from "./server.js";
import { DomainEventDeliveryRepository } from "./domain-event-delivery-repository.js";
import { DomainEventRepository } from "./domain-event-repository.js";

const response = () => ({ writeHead: vi.fn().mockReturnThis(), end: vi.fn(), headersSent: false }) as any;
const user = { subject: "user-1", kind: "human", platformRole: "user", platformCapabilities: [], disabled: false };

function makeServer(capabilities = ["webhooks.manage", "webhooks.view", "workflows.edit", "runs.view"]) {
  const server: any = {
    requireWorkspaceCapability(req: unknown, res: unknown, capability: string) {
      return (WebhookServer.prototype as any).requireWorkspaceCapability.call(this, req, res, capability);
    },
    handleWorkflowInvocationGet(req: unknown, res: unknown, invocationId: string) {
      return (WebhookServer.prototype as any).handleWorkflowInvocationGet.call(this, req, res, invocationId);
    },
    handleJobStatus(req: unknown, jobId: string, res: unknown) {
      return (WebhookServer.prototype as any).handleJobStatus.call(this, req, jobId, res);
    },
    authorizer: {
      workspace: vi.fn(async (_req: unknown, res: any, capability: string) => {
        if (capabilities.includes(capability)) {
          return { principal: user, teamId: "workspace-a", role: "admin", capabilities };
        }
        res.writeHead(403, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: "Forbidden" }));
        return null;
      }),
    },
    domainEventRepository: new DomainEventRepository(),
    domainEventDeliveryRepository: new DomainEventDeliveryRepository(),
    queue: { getJobForTeam: vi.fn(async (_teamId: string, jobId: string) => ({
      id: Number(jobId),
      status: "success",
      created_at: "2026-01-01T00:00:00.000Z",
      updated_at: "2026-01-01T00:01:00.000Z",
    })) },
    workflowsLoaded: Promise.resolve(),
    readJson: vi.fn(async (req: any) => req.body ?? null),
    principals: { recordAudit: vi.fn(async () => {}) },
  };
  return server;
}

async function request(server: any, method: string, path: string, body?: unknown) {
  const res = response();
  await (WebhookServer.prototype as any).handleRequest.call(
    server,
    {
      method,
      url: path,
      body,
      headers: { host: "app.test", "x-team-id": "workspace-a" },
    },
    res,
  );
  return res;
}

describe("POST /api/v1/domain-events", () => {
  beforeEach(() => vi.resetAllMocks());

  it("requires workspace capability and does not publish when denied", async () => {
    const server = makeServer([]);
    const publish = vi.spyOn(server.domainEventRepository, "publish");
    const res = await request(server, "POST", "/api/v1/domain-events", {
      type: "order.created",
      source: "orders",
      data: { orderId: "o1" },
    });
    expect(res.writeHead).toHaveBeenCalledWith(403, expect.any(Object));
    expect(publish).not.toHaveBeenCalled();
  });

  it("rejects malformed event contracts before persistence", async () => {
    const server = makeServer();
    const publish = vi.spyOn(server.domainEventRepository, "publish");
    const res = await request(server, "POST", "/api/v1/domain-events", {
      type: "Order Created",
      source: "orders",
      data: { orderId: "o1" },
      teamId: "other-team",
    });
    expect(res.writeHead).toHaveBeenCalledWith(400, expect.any(Object));
    expect(publish).not.toHaveBeenCalled();
  });

  it("publishes in the authenticated workspace and returns only event metadata", async () => {
    const server = makeServer();
    vi.spyOn(server.domainEventRepository, "publish").mockResolvedValue({ id: "evt-1" } as any);
    vi.spyOn(server.domainEventDeliveryRepository, "fanout").mockResolvedValue({ status: "matched", deliveryCount: 2 });
    const res = await request(server, "POST", "/api/v1/domain-events", {
      type: "order.created",
      source: "orders",
      idempotencyKey: "delivery-1",
      data: { orderId: "o1" },
    });
    expect(server.domainEventRepository.publish).toHaveBeenCalledWith(
      "workspace-a",
      expect.objectContaining({
        type: "order.created",
        source: "orders",
        data: { orderId: "o1" },
      }),
    );
    expect(server.domainEventDeliveryRepository.fanout).toHaveBeenCalledWith("workspace-a", "evt-1");
    expect(res.writeHead).toHaveBeenCalledWith(202, expect.any(Object));
    const body = JSON.parse(res.end.mock.calls[0][0]);
    expect(body).toEqual({ eventId: "evt-1", deliveryCount: 2, fanoutStatus: "matched" });
    expect(JSON.stringify(body)).not.toContain("orderId");
  });

  it("inspects durable workspace-scoped fanout outcomes without revealing event data", async () => {
    const server = makeServer();
    vi.spyOn(server.domainEventDeliveryRepository, "getFanoutOutcome").mockResolvedValue({
      status: "unmatched",
      deliveryCount: 0,
    });
    const res = await request(server, "GET", "/api/v1/domain-events/evt-1/fanout-outcome");
    expect(server.domainEventDeliveryRepository.getFanoutOutcome).toHaveBeenCalledWith("workspace-a", "evt-1");
    expect(JSON.parse(res.end.mock.calls[0][0])).toEqual({ eventId: "evt-1", status: "unmatched", deliveryCount: 0 });
  });

  it("exposes scoped invocation admission and run status without request inputs", async () => {
    const server = makeServer();
    vi.spyOn(server.domainEventRepository, "getWorkflowInvocationForTeam").mockResolvedValue({
      id: "invocation-1",
      teamId: "workspace-a",
      requestEventId: "request-event-1",
      workflowId: "deploy",
      revision: 3,
      recordedAt: "2026-01-01T00:00:00.000Z",
      variants: [
        {
          variantIndex: 0,
          admissionStatus: "admitted",
          admissionOutcome: "accepted",
          errorCode: null,
          runId: "42",
        },
      ],
    });
    const response = await request(server, "GET", "/api/v1/workflow-invocations/invocation-1");
    expect(server.domainEventRepository.getWorkflowInvocationForTeam).toHaveBeenCalledWith(
      "workspace-a",
      "invocation-1",
    );
    expect(JSON.parse(response.end.mock.calls[0][0])).toMatchObject({
      id: "invocation-1",
      variants: [{ runId: "42", admissionStatus: "admitted", admissionOutcome: "accepted" }],
    });
    expect(response.end.mock.calls[0][0]).not.toContain("inputsCiphertext");

    const runStatus = await request(server, "GET", "/api/jobs/42/status");
    expect(server.queue.getJobForTeam).toHaveBeenCalledWith("workspace-a", "42");
    expect(JSON.parse(runStatus.end.mock.calls[0][0])).toMatchObject({ id: 42, status: "success" });

    const denied = makeServer(["workflows.view"]);
    const deniedLookup = vi.spyOn(denied.domainEventRepository, "getWorkflowInvocationForTeam");
    await request(denied, "GET", "/api/v1/workflow-invocations/invocation-1");
    expect(deniedLookup).not.toHaveBeenCalled();

    const malformed = await request(server, "GET", "/api/v1/workflow-invocations/%E0%A4%A");
    expect(malformed.writeHead).toHaveBeenCalledWith(400, expect.anything());
  });

  it("returns conflict for an idempotency key reused with different data", async () => {
    const server = makeServer();
    vi.spyOn(server.domainEventRepository, "publish").mockRejectedValue(
      new Error("Domain event idempotency key conflicts with an existing event"),
    );
    const res = await request(server, "POST", "/api/v1/domain-events", {
      type: "order.created",
      source: "orders",
      idempotencyKey: "delivery-1",
      data: { orderId: "o2" },
    });
    expect(res.writeHead).toHaveBeenCalledWith(409, expect.any(Object));
    expect(res.end.mock.calls[0][0]).not.toContain("o2");
  });
});

describe("POST /api/v1/domain-event-subscriptions", () => {
  beforeEach(() => {
    vi.resetAllMocks();
    database.get.mockResolvedValue(null);
  });

  it("requires workflow edit capability", async () => {
    const server = makeServer(["webhooks.manage"]);
    const res = await request(server, "POST", "/api/v1/domain-event-subscriptions", {
      workflowId: "wf",
      eventType: "order.created",
    });
    expect(res.writeHead).toHaveBeenCalledWith(403, expect.any(Object));
  });

  it("rejects foreign, draft, disabled, or non-active workflows", async () => {
    const server = makeServer();
    const body = { workflowId: "wf", eventType: "order.created" };
    expect((await request(server, "POST", "/api/v1/domain-event-subscriptions", body)).writeHead).toHaveBeenCalledWith(
      404,
      expect.any(Object),
    );

    database.get.mockResolvedValueOnce({ id: "wf", revision: 2, status: "draft", enabled: 1 });
    expect((await request(server, "POST", "/api/v1/domain-event-subscriptions", body)).writeHead).toHaveBeenCalledWith(
      403,
      expect.any(Object),
    );
    database.get.mockResolvedValueOnce({ id: "wf", revision: 2, status: "published", enabled: 0 });
    expect((await request(server, "POST", "/api/v1/domain-event-subscriptions", body)).writeHead).toHaveBeenCalledWith(
      403,
      expect.any(Object),
    );
    database.get.mockResolvedValueOnce({ id: "wf", revision: 2, status: "published", enabled: 1 });
    expect(
      (await request(server, "POST", "/api/v1/domain-event-subscriptions", { ...body, workflowRevision: 1 })).writeHead,
    ).toHaveBeenCalledWith(403, expect.any(Object));
  });

  it("creates an owned future-only subscription and returns metadata", async () => {
    const server = makeServer();
    database.get.mockResolvedValue({ id: "wf", revision: 2, status: "published", enabled: 1 });
    vi.spyOn(server.domainEventDeliveryRepository, "createSubscription").mockResolvedValue({
      id: "sub-1",
      teamId: "workspace-a",
      workflowId: "wf",
      workflowRevision: 2,
      eventType: "order.created",
      enabled: true,
      createdAt: "now",
    });
    const res = await request(server, "POST", "/api/v1/domain-event-subscriptions", {
      workflowId: "wf",
      eventType: "order.created",
    });
    expect(server.domainEventDeliveryRepository.createSubscription).toHaveBeenCalledWith("workspace-a", {
      workflowId: "wf",
      workflowRevision: 2,
      eventType: "order.created",
    });
    expect(res.writeHead).toHaveBeenCalledWith(201, expect.any(Object));
    expect(JSON.parse(res.end.mock.calls[0][0])).toMatchObject({ id: "sub-1", workflowRevision: 2 });
  });
});

describe("durable event delivery inspection and retry", () => {
  beforeEach(() => vi.resetAllMocks());

  it("returns workspace-scoped delivery metadata without exposing event payloads", async () => {
    const server = makeServer();
    vi.spyOn(server.domainEventDeliveryRepository, "listForEvent").mockResolvedValue([
      {
        id: "delivery-1",
        teamId: "workspace-a",
        eventId: "event-1",
        subscriptionId: "subscription-1",
        status: "failed",
        attemptCount: 12,
        leaseUntil: null,
        jobIds: [],
        lastError: "safe diagnostic",
        createdAt: "now",
        updatedAt: "now",
      },
    ]);
    const res = await request(server, "GET", "/api/v1/domain-events/event-1/deliveries");
    expect(server.domainEventDeliveryRepository.listForEvent).toHaveBeenCalledWith("workspace-a", "event-1");
    expect(res.writeHead).toHaveBeenCalledWith(200, expect.any(Object));
    expect(res.end.mock.calls[0][0]).not.toContain("data_json");
  });

  it("allows retry only with manage access and for a matching failed delivery", async () => {
    const deniedServer = makeServer(["webhooks.view"]);
    const denied = await request(deniedServer, "POST", "/api/v1/domain-events/event-1/deliveries/delivery-1/retry");
    expect(denied.writeHead).toHaveBeenCalledWith(403, expect.any(Object));

    const server = makeServer();
    vi.spyOn(server.domainEventDeliveryRepository, "retryFailed").mockResolvedValue({
      id: "delivery-1",
      teamId: "workspace-a",
      eventId: "event-1",
      subscriptionId: "subscription-1",
      status: "pending",
      attemptCount: 0,
      leaseUntil: null,
      jobIds: [],
      lastError: null,
      createdAt: "now",
      updatedAt: "now",
    });
    const res = await request(server, "POST", "/api/v1/domain-events/event-1/deliveries/delivery-1/retry");
    expect(server.domainEventDeliveryRepository.retryFailed).toHaveBeenCalledWith("workspace-a", "delivery-1");
    expect(res.writeHead).toHaveBeenCalledWith(202, expect.any(Object));
    expect(JSON.parse(res.end.mock.calls[0][0])).toEqual({ deliveryId: "delivery-1", status: "pending" });
  });
});
