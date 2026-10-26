import { beforeEach, describe, expect, it, vi } from "vitest";
import crypto from "node:crypto";

const database = vi.hoisted(() => ({
  all: vi.fn(),
  get: vi.fn(),
  run: vi.fn(),
  transaction: vi.fn(),
}));
vi.mock("./db-client.js", () => ({ default: database }));

import { WebhookServer } from "./server.js";
import { WorkflowRunAdmissionRepository } from "./workflow-run-admission-repository.js";

const repository = new WorkflowRunAdmissionRepository();

describe("WorkflowRunAdmissionRepository", () => {
  beforeEach(() => vi.resetAllMocks());

  it("only makes a complete, verified plan claimable", async () => {
    const variants = [0, 1].map((index) => ({
      eventId: "evt-plan",
      teamId: "team",
      workflowId: "wf",
      revision: 1,
      index,
      matrix: { axis: index },
      tags: [],
    }));
    database.transaction.mockRejectedValueOnce(new Error("failure after first insert")).mockResolvedValue(undefined);
    const hash = crypto
      .createHash("sha256")
      .update(variants.map((variant) => JSON.stringify(variant)).join("\n"))
      .digest("hex");
    database.get.mockResolvedValueOnce(null).mockResolvedValueOnce({ variant_count: 2, plan_hash: hash });
    await expect(repository.persistPlan(variants)).rejects.toThrow("failure after first insert");
    database.get.mockResolvedValueOnce(null);
    await expect(repository.claimNext()).resolves.toBeNull();

    await expect(repository.persistPlan(variants)).resolves.toBeUndefined();
    expect(database.transaction).toHaveBeenCalledTimes(2);
    const statements = database.transaction.mock.calls[1][0];
    expect(statements).toHaveLength(3);
    expect(statements.at(-1).s).toContain("INSERT OR IGNORE INTO workflow_run_admission_plans");
    expect(statements.at(-1).s).toContain("EXISTS (SELECT 1 FROM workflow_run_admissions");
  });

  it("persists rejected invocation decisions separately from processing lifecycle", async () => {
    await repository.persistTerminal(
      {
        eventId: "request-event",
        teamId: "team-a",
        workflowId: "build",
        revision: 3,
        index: -1,
        matrix: {},
        tags: [],
      },
      "failed",
      "invalid_inputs",
      "rejected",
    );

    expect(database.run).toHaveBeenCalledWith(expect.stringContaining("admission_outcome"), [
      "request-event",
      "team-a",
      "build",
      3,
      -1,
      "{}",
      "[]",
      "failed",
      "invalid_inputs",
      "rejected",
    ]);
  });

  it("atomically claims pending or expired variants and fences completion by lease token", async () => {
    database.get.mockResolvedValue({
      event_id: "evt",
      team_id: "team",
      workflow_id: "wf",
      revision: 1,
      variant_index: 0,
      matrix_json: "{}",
      tags_json: "[]",
    });
    const claim = await repository.claimNext();
    expect(claim?.token).toMatch(/[0-9a-f-]{36}/);
    expect(database.get.mock.calls[0][0]).toContain("UPDATE workflow_run_admissions");
    expect(database.get.mock.calls[0][0]).toContain("RETURNING *");
    expect(database.get.mock.calls[0][0]).toContain("retry_after");
    expect(database.get.mock.calls[0][0]).toContain("julianday(lease_until)");

    database.get.mockResolvedValue({ owned: 1 });
    database.run.mockResolvedValue({ changes: 0 });
    await expect(repository.ownsLease(claim!)).resolves.toBe(true);
    await expect(repository.finish(claim!, "admitted", 4)).resolves.toBe(false);
    expect(database.get.mock.calls[1][0]).toContain("lease_token = ?");
    expect(database.run.mock.calls[0][0]).toContain("lease_token = ?");
  });

  it("looks up terminal admission state and lease fields", async () => {
    database.get.mockResolvedValue({
      status: "failed",
      job_id: 42,
      error_code: "invalid_inputs",
    });
    await expect(repository.get("evt", 3)).resolves.toEqual({
      status: "failed",
      jobId: 42,
      errorCode: "invalid_inputs",
      leaseToken: null,
      leaseUntil: null,
    });
    expect(database.get.mock.calls[0][0]).toContain("WHERE event_id = ? AND variant_index = ?");
    expect(database.get.mock.calls[0][1]).toEqual(["evt", 3]);
  });

  it("target-claims only planned pending variants and does not double-claim a live lease", async () => {
    database.get
      .mockResolvedValueOnce({
        event_id: "evt",
        team_id: "team",
        workflow_id: "wf",
        revision: 1,
        variant_index: 2,
        matrix_json: "{}",
        tags_json: "[]",
      })
      .mockResolvedValueOnce(null);
    const claim = await repository.claimVariant("evt", 2);
    expect(claim?.index).toBe(2);
    expect(database.get.mock.calls[0][0]).toContain("status = 'pending'");
    expect(database.get.mock.calls[0][0]).toContain("julianday(lease_until)");
    expect(database.get.mock.calls[0][0]).toContain("workflow_run_admission_plans");
    expect(database.get.mock.calls[0][1]).toEqual([
      claim?.token,
      expect.any(String),
      "evt",
      2,
      expect.any(String),
      expect.any(String),
    ]);
    await expect(repository.claimVariant("evt", 2)).resolves.toBeNull();
  });

  it("reclaims an expired targeted lease with a fresh fencing token", async () => {
    database.get
      .mockResolvedValueOnce({
        event_id: "evt",
        team_id: "team",
        workflow_id: "wf",
        revision: 1,
        variant_index: 0,
        matrix_json: "{}",
        tags_json: "[]",
      })
      .mockResolvedValueOnce({
        event_id: "evt",
        team_id: "team",
        workflow_id: "wf",
        revision: 1,
        variant_index: 0,
        matrix_json: "{}",
        tags_json: "[]",
      });
    const first = await repository.claimVariant("evt", 0, 1);
    const second = await repository.claimVariant("evt", 0);
    expect(second?.token).not.toBe(first?.token);
    expect(database.get.mock.calls[1][0]).toContain("julianday(lease_until) <= julianday(?)");
  });

  it("does not target-claim before the plan marker exists", async () => {
    database.get.mockResolvedValue(null);
    await expect(repository.claimVariant("evt", 4)).resolves.toBeNull();
    expect(database.get.mock.calls[0][0]).toContain("EXISTS (SELECT 1 FROM workflow_run_admission_plans");
  });

  it("recovers a partial plan insertion on retry and verifies completeness", async () => {
    const variants = [0, 1].map((index) => ({
      eventId: "evt-plan",
      teamId: "team",
      workflowId: "wf",
      revision: 1,
      index,
      matrix: { axis: index },
      tags: [],
    }));
    database.transaction.mockRejectedValueOnce(new Error("simulated interruption")).mockResolvedValue(undefined);
    const hash = crypto
      .createHash("sha256")
      .update(variants.map((variant) => JSON.stringify(variant)).join("\n"))
      .digest("hex");
    database.get.mockResolvedValue({ variant_count: 2, plan_hash: hash });
    await expect(repository.persistPlan(variants)).rejects.toThrow("simulated interruption");
    await expect(repository.persistPlan(variants)).resolves.toBeUndefined();
  });

  it("rejects incomplete persisted plans", async () => {
    database.run.mockResolvedValue({ changes: 1 });
    database.get.mockImplementation(async (_sql: string, values: unknown[]) => {
      const index = Number(values[1]);
      return {
        team_id: "team",
        workflow_id: "wf",
        revision: 1,
        matrix_json: JSON.stringify({ axis: index }),
        tags_json: "[]",
      };
    });
    database.all.mockResolvedValue([{ variant_index: 0 }]);
    const variants = [0, 1].map((index) => ({
      eventId: "evt-plan",
      teamId: "team",
      workflowId: "wf",
      revision: 1,
      index,
      matrix: { axis: index },
      tags: [],
    }));
    await expect(repository.persistPlan(variants)).rejects.toThrow("incomplete or conflicts");
  });

  it("requires every planned variant to reach a terminal state and recognizes terminal markers", async () => {
    database.all
      .mockResolvedValueOnce([
        { variant_index: 0, status: "admitted" },
        { variant_index: 1, status: "pending" },
      ])
      .mockResolvedValueOnce([
        { variant_index: 0, status: "admitted" },
        { variant_index: 1, status: "failed" },
      ])
      .mockResolvedValueOnce([{ variant_index: -2, status: "admitted" }])
      .mockResolvedValueOnce([{ variant_index: -1, status: "failed" }]);
    database.get.mockResolvedValueOnce(null).mockResolvedValueOnce({ variant_count: 2 });
    await expect(repository.isPlanTerminal("evt", [0, 1])).resolves.toBe(false);
    await expect(repository.isPlanTerminal("evt", [0, 1])).resolves.toBe(true);
    await expect(repository.isPlanTerminal("empty", [])).resolves.toBe(true);
    await expect(repository.isPlanTerminal("invalid", [-1])).resolves.toBe(true);
  });

  it("schedules transient retries durably and orders claims by readiness", async () => {
    database.get.mockResolvedValue(null);
    await repository.claimNext();
    expect(database.get.mock.calls[0][0]).toContain("retry_after");
    expect(database.get.mock.calls[0][0]).toContain("ORDER BY CASE");

    database.run.mockResolvedValue({ changes: 1 });
    const claim = {
      eventId: "evt",
      teamId: "team",
      workflowId: "wf",
      revision: 1,
      index: 0,
      matrix: {},
      tags: [],
      token: "token",
    };
    await repository.finish(claim, "pending");
    expect(database.run.mock.calls[0][0]).toContain("retry_after = CASE");
  });
});

describe("Workflow request recovery", () => {
  const makeServer = (overrides: Record<string, any> = {}) => {
    const event = {
      id: "event-1",
      teamId: "team-1",
      type: "workflow.run.requested",
      source: "api/workflows/run",
      data: {
        workflowId: "workflow-1",
        revision: 1,
        inputsCiphertext: "encrypted",
      },
    };
    const admissions = {
      isPlanTerminal: vi.fn(async () => false),
      persistPlan: vi.fn(async () => {}),
      persistTerminal: vi.fn(async () => {}),
      claimNext: vi.fn(async () => null),
      ...overrides.admissions,
    };
    const server = {
      domainEventRepository: {
        listWorkflowRunRequests: vi.fn(async () => [event]),
      },
      workflowRunAdmissions: admissions,
      workflows: {
        getRevision: vi.fn(async () => ({
          id: "workflow-1",
          matrix: { axis: ["one"] },
          tags: [],
        })),
      },
      secretRepository: { decryptValue: vi.fn(() => "{}") },
      queue: { enqueueDispatch: vi.fn() },
      events: { publish: vi.fn() },
      ...overrides.server,
    };
    return { server, event, admissions };
  };

  it("persists empty matrices as terminal and does not enqueue", async () => {
    const { server, admissions } = makeServer({
      server: {
        workflows: {
          getRevision: vi.fn(async () => ({
            id: "workflow-1",
            matrix: { axis: [] },
            tags: [],
          })),
        },
      },
    });
    await (WebhookServer.prototype as any).recoverWorkflowRunRequests.call(server);
    expect(admissions.persistTerminal).toHaveBeenCalledWith(expect.objectContaining({ index: -2 }), "admitted");
    expect(server.queue.enqueueDispatch).not.toHaveBeenCalled();
  });

  it("records decryption and matrix-resolution errors without persisting sensitive inputs", async () => {
    const badCiphertext = makeServer({
      server: {
        secretRepository: {
          decryptValue: vi.fn(() => {
            throw new Error("bad ciphertext");
          }),
        },
      },
    });
    await (WebhookServer.prototype as any).recoverWorkflowRunRequests.call(badCiphertext.server);
    expect(badCiphertext.admissions.persistTerminal).toHaveBeenCalledWith(
      expect.objectContaining({ index: -1 }),
      "failed",
      "invalid_inputs",
    );

    const badMatrix = makeServer({
      server: {
        workflows: {
          getRevision: vi.fn(async () => ({
            id: "workflow-1",
            matrix: { axis: ["one"] },
            tags: ["${inputs.missing.toUpperCase()}"],
          })),
        },
      },
    });
    await (WebhookServer.prototype as any).recoverWorkflowRunRequests.call(badMatrix.server);
    expect(badMatrix.admissions.persistTerminal).toHaveBeenCalledWith(
      expect.objectContaining({ index: -1 }),
      "failed",
      "invalid_matrix",
    );
    expect(JSON.stringify(badMatrix.admissions.persistTerminal.mock.calls)).not.toContain("encrypted");
  });

  it("leaves transient registry and plan-persistence failures retryable", async () => {
    const registryUnavailable = makeServer({
      server: {
        workflows: {
          getRevision: vi.fn(async () => {
            throw new Error("database unavailable");
          }),
        },
      },
    });
    await (WebhookServer.prototype as any).recoverWorkflowRunRequests.call(registryUnavailable.server);
    expect(registryUnavailable.admissions.persistTerminal).not.toHaveBeenCalled();

    const planPersistenceFailed = makeServer({
      admissions: {
        persistPlan: vi.fn(async () => {
          throw new Error("write failed");
        }),
      },
      server: {
        workflows: {
          getRevision: vi
            .fn()
            .mockResolvedValueOnce({ id: "workflow-1", matrix: {}, tags: [] })
            .mockResolvedValueOnce({ id: "workflow-1", matrix: {}, tags: [] }),
        },
      },
    });
    await (WebhookServer.prototype as any).recoverWorkflowRunRequests.call(planPersistenceFailed.server);
    expect(planPersistenceFailed.admissions.persistTerminal).not.toHaveBeenCalled();
  });

  it("does not rescan an already-terminal request marker", async () => {
    const { server, admissions } = makeServer({
      admissions: {
        isPlanTerminal: vi.fn(async (_eventId: string, indices: number[]) => indices[0] === -1),
      },
    });
    await (WebhookServer.prototype as any).recoverWorkflowRunRequests.call(server);
    expect(server.workflows.getRevision).not.toHaveBeenCalled();
    expect(admissions.persistTerminal).not.toHaveBeenCalled();
  });

  it("scans past a full page of terminal requests to admit later pending requests", async () => {
    const events = Array.from({ length: 101 }, (_, index) => ({
      id: `event-${index}`,
      sequence: index + 1,
      teamId: "team-1",
      type: "workflow.run.requested",
      source: "api/workflows/run",
      recordedAt: new Date(Date.UTC(2026, 9, 24, 0, 0, index)).toISOString(),
      data: {
        workflowId: "workflow-1",
        revision: 1,
        inputsCiphertext: "encrypted",
      },
    }));
    const { server, admissions } = makeServer({
      admissions: {
        isPlanTerminal: vi.fn(
          async (eventId: string, indices: number[]) => eventId !== "event-100" && indices[0] === -1,
        ),
        claimNext: vi
          .fn()
          .mockResolvedValueOnce({
            eventId: "event-100",
            teamId: "team-1",
            workflowId: "workflow-1",
            revision: 1,
            index: 0,
            matrix: { axis: "one" },
            tags: [],
            token: "claim-token",
          })
          .mockResolvedValueOnce(null),
        finish: vi.fn(async () => true),
      },
      server: {
        domainEventRepository: {
          listWorkflowRunRequests: vi.fn(async (_limit: number, _offset: number, cursorSequence?: number) =>
            cursorSequence ? [events[100]] : events.slice(0, 100),
          ),
          getForTeam: vi.fn(async () => events[100]),
        },
        queue: { enqueueDispatch: vi.fn(async () => 501) },
      },
    });
    (server as any).processWorkflowRunAdmission = WebhookServer.prototype.processWorkflowRunAdmission;

    await (WebhookServer.prototype as any).recoverWorkflowRunRequests.call(server);

    expect(server.domainEventRepository.listWorkflowRunRequests).toHaveBeenCalledTimes(2);
    expect(server.domainEventRepository.listWorkflowRunRequests.mock.calls[1][2]).toBe(events[99].sequence);
    expect(admissions.persistPlan).toHaveBeenCalledWith([
      expect.objectContaining({
        eventId: "event-100",
        workflowId: "workflow-1",
        index: 0,
      }),
    ]);
    expect(server.queue.enqueueDispatch).toHaveBeenCalledWith(
      "workflow-1",
      1,
      { inputs: {}, matrix: { axis: "one" } },
      [],
      "team-1",
      "event-100",
      "workflow-run:event-100:0",
      { eventId: "event-100", variantIndex: 0, leaseToken: "claim-token" },
    );
    expect(admissions.finish).toHaveBeenCalledWith(expect.objectContaining({ eventId: "event-100" }), "admitted", 501);
  });

  it("returns each recovered claim without leaving a second claim stranded", async () => {
    const pending = [
      {
        eventId: "event-a",
        teamId: "team",
        workflowId: "wf",
        revision: 1,
        index: 0,
      },
      {
        eventId: "event-b",
        teamId: "team",
        workflowId: "wf",
        revision: 1,
        index: 1,
      },
    ];
    const admissions = {
      reclaimExpired: vi.fn(async () => 0),
      claimNext: vi.fn(async () => pending.shift() ?? null),
    };
    const result = await (WebhookServer.prototype as any).recoverCrash.call({
      workflowRunAdmissions: admissions,
    });
    expect(result.map((claim: any) => [claim.eventId, claim.index])).toEqual([
      ["event-a", 0],
      ["event-b", 1],
    ]);
    expect(pending).toHaveLength(0);
    expect(admissions.claimNext).toHaveBeenCalledTimes(3);
  });
});
