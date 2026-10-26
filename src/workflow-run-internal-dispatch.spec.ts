import { beforeEach, describe, expect, it, vi } from "vitest";
import { WebhookServer } from "./server.js";

const database = vi.hoisted(() => ({ get: vi.fn() }));
vi.mock("./db-client.js", () => ({ default: database }));

function makeServer(options: { existingEvent?: any; matrix?: Record<string, unknown> } = {}) {
  const events = new Map<string, any>();
  const admissions = new Map<number, any>();
  const domainEventRepository = {
    getByIdempotencyKey: vi.fn(
      async (_teamId: string, key: string) => options.existingEvent || events.get(key) || null,
    ),
    publish: vi.fn(async (_teamId: string, request: any) => {
      const event = { id: "dispatch-request-1", teamId: "team-a", ...request };
      events.set(request.idempotencyKey, event);
      return event;
    }),
    getForTeam: vi.fn(
      async (_teamId: string, eventId: string) =>
        [...events.values()].find((event) => event.id === eventId) || options.existingEvent,
    ),
  };
  const queue = {
    enqueueDispatch: vi.fn(
      async (
        _workflowId: string,
        _revision: number,
        _payload: unknown,
        _tags: string[],
        _teamId: string,
        _parentId: any,
        dispatchKey: string,
      ) => (dispatchKey.endsWith(":1") ? 102 : 101),
    ),
  };
  const workflowRunAdmissions = {
    persistTerminal: vi.fn(async (variant: any, status: string, errorCode?: string) => {
      admissions.set(variant.index, { status, errorCode, jobId: null });
    }),
    persistPlan: vi.fn(async () => {}),
    get: vi.fn(async (_eventId: string, index: number) => admissions.get(index) || { status: "pending", jobId: null }),
    claimVariant: vi.fn(async (eventId: string, index: number) => {
      const current = admissions.get(index);
      if (current?.status === "admitted" || current?.status === "failed" || current?.status === "claimed") {
        return null;
      }
      const claim = {
        eventId,
        teamId: "team-a",
        workflowId: "workflow-1",
        revision: 4,
        index,
        matrix: index === 0 ? { node: 18 } : { node: 20 },
        tags: [],
        token: `claim-${index}`,
      };
      admissions.set(index, { status: "claimed", jobId: null });
      return claim;
    }),
    finish: vi.fn(async (claim: any, status: string, jobId?: number, errorCode?: string) => {
      admissions.set(claim.index, { status, jobId: jobId ?? null, errorCode });
      return true;
    }),
  };
  const server = {
    workflows: {
      publishedForTeam: vi.fn(async () => [
        {
          workflowId: "workflow-1",
          revision: 4,
          definition: { id: "workflow-1", name: "Build", steps: [], matrix: options.matrix || {} },
        },
      ]),
      getRevision: vi.fn(async () => ({ id: "workflow-1", steps: [], matrix: options.matrix || {} })),
    },
    domainEventRepository,
    workflowRunAdmissions,
    secretRepository: {
      encryptValue: vi.fn((value: string) => `cipher:${value}`),
      decryptValue: vi.fn((value: string) => value.replace(/^cipher:/, "")),
    },
    queue,
    events: { publish: vi.fn() },
  };
  (server as any).processWorkflowRunAdmission = WebhookServer.prototype.processWorkflowRunAdmission;
  (server as any).admitDispatchVariant = WebhookServer.prototype.admitDispatchVariant;
  return { server, domainEventRepository, workflowRunAdmissions, queue, events, admissions };
}

const job = { id: 77, team_id: "team-a", status: "running" };
const request = { jobId: 77, stepId: "build-child", target: "workflow-1", inputs: { source: "main" } };

describe("durable internal workflow dispatch", () => {
  beforeEach(() => {
    vi.resetAllMocks();
    database.get.mockResolvedValue({ depth: 0 });
  });

  it("pins, persists, and admits each planned variant with the legacy dispatch key", async () => {
    const { server, domainEventRepository, workflowRunAdmissions, queue } = makeServer({ matrix: { node: [18, 20] } });

    const result = await (WebhookServer.prototype as any).dispatchFromLease.call(server, job, request);

    expect(result).toMatchObject({
      jobId: 101,
      jobIds: [101, 102],
      workflowId: "workflow-1",
      parentId: 77,
      invocationId: expect.any(String),
    });
    expect(domainEventRepository.publish).toHaveBeenCalledWith(
      "team-a",
      expect.objectContaining({
        type: "workflow.run.requested",
        source: "runner/workflow-dispatch",
        idempotencyKey: "workflow-dispatch:77:build-child",
        data: expect.objectContaining({ workflowId: "workflow-1", revision: 4, parentJobId: 77 }),
      }),
    );
    expect(workflowRunAdmissions.persistPlan).toHaveBeenCalledOnce();
    expect(queue.enqueueDispatch).toHaveBeenNthCalledWith(
      1,
      "workflow-1",
      4,
      { inputs: { source: "main" }, matrix: { node: 18 } },
      [],
      "team-a",
      77,
      "dispatch:77:build-child",
      expect.objectContaining({ eventId: "dispatch-request-1", variantIndex: 0, leaseToken: "claim-0" }),
    );
    expect(queue.enqueueDispatch).toHaveBeenNthCalledWith(
      2,
      "workflow-1",
      4,
      { inputs: { source: "main" }, matrix: { node: 20 } },
      [],
      "team-a",
      77,
      "dispatch:77:build-child:1",
      expect.objectContaining({ eventId: "dispatch-request-1", variantIndex: 1, leaseToken: "claim-1" }),
    );
  });

  it("returns the same child job on a retry and rejects conflicting inputs", async () => {
    const first = makeServer();
    const initial = await (WebhookServer.prototype as any).dispatchFromLease.call(first.server, job, request);
    const existingEvent = [...first.events.values()][0];
    first.workflowRunAdmissions.get.mockResolvedValue({ status: "admitted", jobId: 101 });
    const retryServer = makeServer({ existingEvent });
    retryServer.workflowRunAdmissions.get.mockResolvedValue({ status: "admitted", jobId: 101 });

    const retry = await (WebhookServer.prototype as any).dispatchFromLease.call(retryServer.server, job, request);
    expect(retry.jobId).toBe(initial.jobId);
    expect(retry.invocationId).toBe(initial.invocationId);
    expect(retryServer.domainEventRepository.publish).not.toHaveBeenCalled();

    await expect(
      (WebhookServer.prototype as any).dispatchFromLease.call(retryServer.server, job, {
        ...request,
        inputs: { source: "release" },
      }),
    ).rejects.toMatchObject({ status: 409 });
  });
});
