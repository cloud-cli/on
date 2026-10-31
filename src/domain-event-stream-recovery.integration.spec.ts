import { afterEach, describe, expect, it, vi } from "vitest";
import { DatabaseSync } from "node:sqlite";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const testDb = vi.hoisted(() => ({ database: null as DatabaseSync | null }));
let temporaryDirectory: string | null = null;
vi.mock("./db-client.js", () => {
  const execute = (sql: string, values: unknown[] = []) => testDb.database!.prepare(sql).run(...(values as any[]));
  return {
    default: {
      all: async (sql: string, values: unknown[] = []) => testDb.database!.prepare(sql).all(...(values as any[])),
      get: async (sql: string, values: unknown[] = []) => testDb.database!.prepare(sql).get(...(values as any[])),
      run: async (sql: string, values: unknown[] = []) => execute(sql, values),
      transaction: async (statements: Array<{ s: string; d: unknown[] }>) => {
        testDb.database!.exec("BEGIN IMMEDIATE");
        try {
          for (const statement of statements) {
            testDb.database!.prepare(statement.s).run(...(statement.d as any[]));
          }
          testDb.database!.exec("COMMIT");
        } catch (error) {
          testDb.database!.exec("ROLLBACK");
          throw error;
        }
      },
    },
  };
});

import { DomainEventRepository } from "./domain-event-repository.js";
import { WebhookServer } from "./server.js";
import { WorkflowRunAdmissionRepository } from "./workflow-run-admission-repository.js";
import { QueueManager } from "./queue.js";

const response = () => ({ writeHead: vi.fn().mockReturnThis(), end: vi.fn(), headersSent: false }) as any;

afterEach(() => {
  testDb.database?.close();
  testDb.database = null;
  if (temporaryDirectory) {
    fs.rmSync(temporaryDirectory, { recursive: true, force: true });
    temporaryDirectory = null;
  }
});

describe("persisted Stream event reconciliation", () => {
  it("resumes by durable sequence after SQLite reopen and isolates workspace cursors", async () => {
    temporaryDirectory = fs.mkdtempSync(path.join(os.tmpdir(), "stream-event-recovery-"));
    const databasePath = path.join(temporaryDirectory, "events.sqlite");
    testDb.database = new DatabaseSync(databasePath);
    testDb.database.exec(`
      CREATE TABLE domain_events (
        sequence INTEGER PRIMARY KEY AUTOINCREMENT, id TEXT NOT NULL, team_id TEXT NOT NULL,
        type TEXT NOT NULL, schema_version INTEGER NOT NULL, source TEXT NOT NULL,
        occurred_at TEXT NOT NULL, recorded_at TEXT NOT NULL, correlation_id TEXT, causation_id TEXT,
        idempotency_key TEXT, data_json TEXT NOT NULL, UNIQUE(team_id, id)
      );
      CREATE TABLE channels (id TEXT NOT NULL, team_id TEXT NOT NULL, PRIMARY KEY(team_id, id));
      CREATE TABLE stream_event_bindings (
        team_id TEXT NOT NULL, stream_id TEXT NOT NULL, event_id TEXT NOT NULL,
        PRIMARY KEY(team_id, stream_id, event_id)
      );
      CREATE TABLE channel_messages (id TEXT, team_id TEXT, channel_id TEXT, caused_by_event_id TEXT);
      CREATE TABLE domain_event_deliveries (
        team_id TEXT, event_id TEXT, status TEXT, job_ids_json TEXT, invocation_id TEXT
      );
      CREATE TABLE jobs (id INTEGER PRIMARY KEY, team_id TEXT, status TEXT, updated_at TEXT, finished_at TEXT, report TEXT);
      CREATE TABLE workflow_run_admissions (
        team_id TEXT, event_id TEXT, workflow_id TEXT, revision INTEGER, variant_index INTEGER,
        status TEXT, job_id INTEGER, error_code TEXT, admission_outcome TEXT
      );
      INSERT INTO channels VALUES ('stream-a', 'team-a'), ('stream-a', 'team-b');
      INSERT INTO domain_events VALUES
        (1, 'event-a1', 'team-a', 'audit.created', 1, 'test', '2026-01-01T00:00:00Z', '2026-01-01T00:00:00Z', NULL, NULL, NULL, '{}'),
        (2, 'event-b1', 'team-b', 'audit.created', 1, 'test', '2026-01-01T00:00:00Z', '2026-01-01T00:00:00Z', NULL, NULL, NULL, '{}'),
        (3, 'event-a2', 'team-a', 'audit.created', 1, 'test', '2026-01-02T00:00:00Z', '2026-01-02T00:00:00Z', NULL, NULL, NULL, '{}'),
        (4, 'event-a3', 'team-a', 'audit.created', 1, 'test', '2026-01-03T00:00:00Z', '2026-01-03T00:00:00Z', NULL, NULL, NULL, '{}'),
        (5, 'request-event-1', 'team-a', 'workflow.run.requested', 1, 'api', '2026-01-04T00:00:00Z', '2026-01-04T00:00:00Z', NULL, NULL, NULL,
         '{"workflowId":"deploy","revision":7,"invocationId":"invocation-1","inputsCiphertext":"do-not-return"}'),
        (6, 'request-event-rejected', 'team-a', 'workflow.run.requested', 1, 'api', '2026-01-05T00:00:00Z', '2026-01-05T00:00:00Z', NULL, NULL, NULL,
         '{"workflowId":"deploy","revision":7,"invocationId":"invocation-rejected","inputsCiphertext":"do-not-return"}');
      INSERT INTO jobs (id, team_id, status) VALUES (42, 'team-a', 'running');
      INSERT INTO workflow_run_admissions VALUES ('team-a', 'request-event-1', 'deploy', 7, 0, 'admitted', 42, NULL, 'accepted');
      INSERT INTO workflow_run_admissions VALUES ('team-a', 'request-event-rejected', 'deploy', 7, -1, 'failed', NULL, 'invalid_inputs', 'rejected');
      INSERT INTO domain_event_deliveries VALUES ('team-a', 'event-a2', 'admitted', '[]', 'invocation-1');
      INSERT INTO stream_event_bindings VALUES
        ('team-a', 'stream-a', 'event-a1'), ('team-b', 'stream-a', 'event-b1'), ('team-a', 'stream-a', 'event-a3');
    `);

    const repository = new DomainEventRepository();
    const firstPage = await repository.listChannelEvents("team-a", "stream-a", 1);
    expect(firstPage.events.map(({ id }) => id)).toEqual(["event-a1"]);
    expect(firstPage.nextCursor).toBeTruthy();
    testDb.database.prepare("INSERT INTO stream_event_bindings VALUES ('team-a', 'stream-a', 'event-a2')").run();

    testDb.database.close();
    testDb.database = new DatabaseSync(databasePath);
    const afterRestart = new DomainEventRepository();
    const queue = new QueueManager("test-worker");
    await expect(afterRestart.getWorkflowInvocationForTeam("team-a", "invocation-1")).resolves.toMatchObject({
      variants: [{ jobStatus: "running", completedAt: null }],
    });
    await queue.finishJob(42, "success");
    await expect(afterRestart.getWorkflowInvocationForTeam("team-a", "invocation-1")).resolves.toMatchObject({
      variants: [{ jobStatus: "success", completedAt: expect.any(String) }],
    });
    testDb.database.prepare("INSERT INTO jobs (id, team_id, status) VALUES (43, 'team-a', 'running')").run();
    testDb.database.prepare(`UPDATE workflow_run_admissions SET job_id = 43 WHERE event_id = 'request-event-1'`).run();
    await queue.finishJob(43, "failed");
    await expect(afterRestart.getWorkflowInvocationForTeam("team-a", "invocation-1")).resolves.toMatchObject({
      variants: [{ jobStatus: "failed", completedAt: expect.any(String) }],
    });
    testDb.database.prepare("INSERT INTO jobs (id, team_id, status) VALUES (44, 'team-b', 'success')").run();
    testDb.database.prepare(`UPDATE workflow_run_admissions SET job_id = 44 WHERE event_id = 'request-event-1'`).run();
    await expect(afterRestart.getWorkflowInvocationForTeam("team-a", "invocation-1")).resolves.toMatchObject({
      variants: [{ jobStatus: null, completedAt: null }],
    });
    testDb.database.prepare(`UPDATE workflow_run_admissions SET job_id = 42 WHERE event_id = 'request-event-1'`).run();
    const resumed = await afterRestart.listChannelEvents("team-a", "stream-a", 10, firstPage.nextCursor!);
    expect(resumed.events.map(({ id }) => id)).toEqual(["event-a2", "event-a3"]);
    expect(resumed.events[0].links).toMatchObject({ invocationIds: ["invocation-1"], runIds: ["42"] });
    expect(resumed.events.some(({ id }) => id === "event-b1")).toBe(false);
    await expect(afterRestart.getWorkflowInvocationForTeam("team-a", "invocation-1")).resolves.toEqual({
      id: "invocation-1",
      teamId: "team-a",
      requestEventId: "request-event-1",
      workflowId: "deploy",
      revision: 7,
      recordedAt: "2026-01-04T00:00:00Z",
      variants: [
        {
          variantIndex: 0,
          admissionStatus: "admitted",
          admissionOutcome: "accepted",
          errorCode: null,
          runId: "42",
          jobStatus: "success",
          completedAt: expect.any(String),
        },
      ],
    });
    await expect(afterRestart.getWorkflowInvocationForTeam("team-b", "invocation-1")).resolves.toBeNull();
    await expect(afterRestart.getWorkflowInvocationForTeam("team-a", "invocation-rejected")).resolves.toMatchObject({
      id: "invocation-rejected",
      requestEventId: "request-event-rejected",
      variants: [
        {
          variantIndex: -1,
          admissionStatus: "failed",
          admissionOutcome: "rejected",
          errorCode: "invalid_inputs",
          runId: null,
        },
      ],
    });
    await expect(afterRestart.listChannelEvents("team-b", "stream-a", 10, firstPage.nextCursor!)).rejects.toThrow(
      "Invalid event cursor",
    );
  });

  it("links an authorized Agent invocation to an admitted job through the scoped projection", async () => {
    temporaryDirectory = fs.mkdtempSync(path.join(os.tmpdir(), "agent-invocation-result-"));
    testDb.database = new DatabaseSync(path.join(temporaryDirectory, "agent.sqlite"));
    testDb.database.exec(`
      CREATE TABLE domain_events (
        sequence INTEGER PRIMARY KEY AUTOINCREMENT, id TEXT NOT NULL, team_id TEXT NOT NULL,
        type TEXT NOT NULL, schema_version INTEGER NOT NULL, source TEXT NOT NULL,
        occurred_at TEXT NOT NULL, recorded_at TEXT NOT NULL, correlation_id TEXT, causation_id TEXT,
        idempotency_key TEXT, data_json TEXT NOT NULL, UNIQUE(team_id, id), UNIQUE(team_id, idempotency_key)
      );
      CREATE TABLE workflow_run_admissions (
        event_id TEXT NOT NULL, team_id TEXT NOT NULL, workflow_id TEXT NOT NULL, revision INTEGER NOT NULL,
        variant_index INTEGER NOT NULL, matrix_json TEXT NOT NULL, tags_json TEXT NOT NULL,
        status TEXT NOT NULL DEFAULT 'pending', admission_outcome TEXT, job_id INTEGER, error_code TEXT,
        lease_token TEXT, lease_until TEXT, retry_after TEXT, updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
        PRIMARY KEY (event_id, variant_index)
      );
      CREATE TABLE workflow_run_admission_plans (
        event_id TEXT PRIMARY KEY, variant_count INTEGER NOT NULL, plan_hash TEXT NOT NULL
      );
       CREATE TABLE jobs (id INTEGER PRIMARY KEY, team_id TEXT NOT NULL, status TEXT NOT NULL, updated_at TEXT, finished_at TEXT, report TEXT);
    `);

    let workspaceId = "team-a";
    let granted = true;
    const domainEventRepository = new DomainEventRepository();
    const workflowRunAdmissions = new WorkflowRunAdmissionRepository();
    const server = {
      requireWorkspaceCapability: vi.fn(async (_req: unknown, _res: unknown, _capability: string) => ({
        teamId: workspaceId,
        principal: { kind: "agent", subject: "agent-1" },
        capabilities: ["runs.dispatch", "runs.view"],
      })),
      readJson: vi.fn(async () => ({ inputs: { privateValue: "do-not-return" } })),
      workflowsLoaded: Promise.resolve(),
      workflows: {
        getForTeam: vi.fn(async () => ({ id: "workflow-1" })),
        latestRevision: vi.fn(async () => ({ revision: 1 })),
        getRevision: vi.fn(async () => ({ id: "workflow-1", tags: [], steps: [] })),
      },
      agentWorkflowGrantRepository: { has: vi.fn(async () => granted) },
      domainEventRepository,
      workflowRunAdmissions,
      queue: { enqueueDispatch: vi.fn(async () => 42) },
      events: { publish: vi.fn() },
      secretRepository: {
        encryptValue: (value: string) => `cipher:${value}`,
        decryptValue: (value: string) => value.replace(/^cipher:/, ""),
      },
    };
    const request = { method: "POST", headers: { "idempotency-key": "agent-run-1" } } as any;
    const acceptedResponse = response();
    await (WebhookServer.prototype as any).handleWorkflowRun.call(server, request, acceptedResponse, "workflow-1");
    const accepted = JSON.parse(acceptedResponse.end.mock.calls[0][0]);
    expect(acceptedResponse.writeHead).toHaveBeenCalledWith(202, expect.any(Object));
    expect(accepted).toMatchObject({ accepted: true, admissionStatus: "pending", workflowId: "workflow-1" });
    expect(accepted.invocationId).toBeTruthy();

    const retryResponse = response();
    await (WebhookServer.prototype as any).handleWorkflowRun.call(server, request, retryResponse, "workflow-1");
    expect(JSON.parse(retryResponse.end.mock.calls[0][0])).toMatchObject({
      eventId: accepted.eventId,
      invocationId: accepted.invocationId,
    });
    expect(testDb.database.prepare("SELECT COUNT(*) AS count FROM domain_events").get()?.count).toBe(1);

    await workflowRunAdmissions.persistPlan([
      {
        eventId: accepted.eventId,
        teamId: "team-a",
        workflowId: "workflow-1",
        revision: 1,
        index: 0,
        matrix: {},
        tags: [],
      },
    ]);
    const claim = await workflowRunAdmissions.claimVariant(accepted.eventId, 0);
    expect(claim).not.toBeNull();
    (server as any).processWorkflowRunAdmission = WebhookServer.prototype.processWorkflowRunAdmission;
    await (WebhookServer.prototype as any).processWorkflowRunAdmission.call(server, claim);
    expect(server.queue.enqueueDispatch).toHaveBeenCalledWith(
      "workflow-1",
      1,
      { inputs: { privateValue: "do-not-return", trigger: { type: "manual", source: "api" } }, matrix: {} },
      [],
      "team-a",
      accepted.eventId,
      `workflow-run:${accepted.eventId}:0`,
      expect.objectContaining({ eventId: accepted.eventId, variantIndex: 0 }),
    );
    // Queue admission is exercised above; this terminal job row represents the
    // worker result fixture, so this test verifies correlation, not execution.
    testDb.database.prepare("INSERT INTO jobs (id, team_id, status) VALUES (?, ?, ?)").run(42, "team-a", "success");

    const resultResponse = response();
    await (WebhookServer.prototype as any).handleWorkflowInvocationGet.call(
      server,
      { method: "GET" },
      resultResponse,
      accepted.invocationId,
    );
    expect(resultResponse.writeHead).toHaveBeenCalledWith(200, expect.any(Object));
    const invocation = JSON.parse(resultResponse.end.mock.calls[0][0]);
    expect(invocation).toMatchObject({
      id: accepted.invocationId,
      requestEventId: accepted.eventId,
      teamId: "team-a",
      variants: [{ admissionStatus: "admitted", admissionOutcome: "accepted", runId: "42" }],
    });
    expect(JSON.stringify(invocation)).not.toContain("do-not-return");
    expect(JSON.stringify(invocation)).not.toContain("cipher:");
    expect(testDb.database.prepare("SELECT status FROM jobs WHERE id = ?").get(42)?.status).toBe("success");

    workspaceId = "team-b";
    const isolatedResponse = response();
    await (WebhookServer.prototype as any).handleWorkflowInvocationGet.call(
      server,
      { method: "GET" },
      isolatedResponse,
      accepted.invocationId,
    );
    expect(isolatedResponse.writeHead).toHaveBeenCalledWith(404, expect.any(Object));

    granted = false;
    const deniedResponse = response();
    await (WebhookServer.prototype as any).handleWorkflowRun.call(server, request, deniedResponse, "workflow-1");
    expect(deniedResponse.writeHead).toHaveBeenCalledWith(403, expect.any(Object));
    expect(server.agentWorkflowGrantRepository.has).toHaveBeenCalledWith("team-b", "agent-1", "workflow-1");
    expect(testDb.database.prepare("SELECT COUNT(*) AS count FROM domain_events").get()?.count).toBe(1);
  });
});
