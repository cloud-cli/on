import { afterEach, describe, expect, it, vi } from "vitest";
import { DatabaseSync } from "node:sqlite";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const testDb = vi.hoisted(() => ({ database: null as DatabaseSync | null, get: vi.fn() }));
let temporaryDirectory: string | null = null;
vi.mock("./db-client.js", () => ({
  default: {
    all: async (sql: string, values: unknown[] = []) => testDb.database!.prepare(sql).all(...(values as any[])),
    get: async (sql: string, values: unknown[] = []) =>
      sql.includes("MAX(depth)") ? testDb.get(sql, values) : testDb.database!.prepare(sql).get(...(values as any[])),
    run: async (sql: string, values: unknown[] = []) => testDb.database!.prepare(sql).run(...(values as any[])),
  },
}));

import { WebhookServer } from "./server.js";
import { WorkflowRunAdmissionRepository } from "./workflow-run-admission-repository.js";

const response = () => ({ writeHead: vi.fn().mockReturnThis(), end: vi.fn(), headersSent: false }) as any;
const request = () =>
  ({ url: "/api/v1/workflows/workflow-1/run", method: "POST", headers: { "idempotency-key": "reject" } }) as any;

afterEach(() => {
  testDb.database?.close();
  testDb.database = null;
  if (temporaryDirectory) {
    fs.rmSync(temporaryDirectory, { recursive: true, force: true });
    temporaryDirectory = null;
  }
  testDb.get.mockReset();
  vi.restoreAllMocks();
});

function createTables(database: DatabaseSync) {
  database.exec(`
    CREATE TABLE workflow_run_admissions (
      event_id TEXT NOT NULL, team_id TEXT NOT NULL, workflow_id TEXT NOT NULL, revision INTEGER NOT NULL,
      variant_index INTEGER NOT NULL, matrix_json TEXT NOT NULL, tags_json TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'pending', admission_outcome TEXT, job_id INTEGER, error_code TEXT,
      lease_token TEXT, lease_until TEXT, retry_after TEXT, updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      PRIMARY KEY (event_id, variant_index)
    );
    CREATE TABLE workflow_run_admission_plans (event_id TEXT PRIMARY KEY, variant_count INTEGER NOT NULL, plan_hash TEXT NOT NULL);
  `);
}

describe("workflow-run admission cross-path SQLite integration", () => {
  it("retains rejected API admission across an idempotent API retry", async () => {
    temporaryDirectory = fs.mkdtempSync(path.join(os.tmpdir(), "workflow-admission-paths-"));
    const databasePath = path.join(temporaryDirectory, "test.sqlite");
    testDb.database = new DatabaseSync(databasePath);
    createTables(testDb.database);
    const admissions = new WorkflowRunAdmissionRepository();
    const event: any = {
      id: "request-event",
      teamId: "team-1",
      type: "workflow.run.requested",
      source: "api/workflows/run",
      data: { workflowId: "workflow-1", revision: 1, inputsCiphertext: "encrypted" },
    };
    const domainEventRepository = {
      getByIdempotencyKey: vi.fn(async () => null as any),
      publish: vi.fn(async (_teamId: string, published: any) => {
        event.data = published.data;
        return event;
      }),
    };
    const apiServer = {
      requireWorkspaceCapability: vi.fn(async () => ({ teamId: "team-1", principal: { kind: "human" } })),
      readJson: vi.fn(async () => ({ inputs: { invalid: "value" } })),
      workflowsLoaded: Promise.resolve(),
      workflows: {
        getForTeam: vi.fn(async () => ({ id: "workflow-1" })),
        latestRevision: vi.fn(async () => ({ revision: 1 })),
        getRevision: vi.fn(async () => ({ tags: ["${("], steps: [] })),
      },
      domainEventRepository,
      workflowRunAdmissions: admissions,
      secretRepository: {
        encryptValue: (value: string) => value,
        decryptValue: () => JSON.stringify({ invalid: "value", trigger: { type: "manual", source: "api" } }),
      },
    };

    const firstResponse = response();
    await (WebhookServer.prototype as any).handleWorkflowRun.call(apiServer, request(), firstResponse, "workflow-1");
    const firstBody = JSON.parse(firstResponse.end.mock.calls[0][0]);
    expect(firstResponse.writeHead).toHaveBeenCalledWith(400, expect.any(Object));
    expect(firstBody).toMatchObject({ eventId: event.id, admissionOutcome: "rejected" });
    expect(domainEventRepository.publish).toHaveBeenCalledOnce();

    domainEventRepository.getByIdempotencyKey.mockResolvedValue(event);
    const retryResponse = response();
    await (WebhookServer.prototype as any).handleWorkflowRun.call(apiServer, request(), retryResponse, "workflow-1");
    expect(JSON.parse(retryResponse.end.mock.calls[0][0])).toMatchObject(firstBody);
    expect(domainEventRepository.publish).toHaveBeenCalledOnce();

    const rejected = await admissions.get(event.id, -1);
    expect(rejected).toMatchObject({ status: "failed", admissionOutcome: "rejected", errorCode: "invalid_inputs" });

    testDb.database.close();
    testDb.database = new DatabaseSync(databasePath);
    const reopened = new WorkflowRunAdmissionRepository();
    expect(await reopened.get(event.id, -1)).toMatchObject(rejected);
    expect(await reopened.list(event.id)).toMatchObject([
      expect.objectContaining({
        variant_index: -1,
        status: "failed",
        error_code: "invalid_inputs",
      }),
    ]);
  });

  it("records and preserves the internal-dispatch rejection on same-step retry", async () => {
    temporaryDirectory = fs.mkdtempSync(path.join(os.tmpdir(), "workflow-dispatch-outcome-"));
    const databasePath = path.join(temporaryDirectory, "test.sqlite");
    testDb.database = new DatabaseSync(databasePath);
    createTables(testDb.database);
    testDb.get.mockResolvedValue({ depth: 0 });
    const admissions = new WorkflowRunAdmissionRepository();
    const storedEvents = new Map<string, any>();
    const domainEventRepository = {
      getByIdempotencyKey: vi.fn(async (_teamId: string, key: string) => storedEvents.get(key) || null),
      publish: vi.fn(async (_teamId: string, request: any) => {
        const event = { id: "dispatch-event", teamId: "team-1", ...request };
        storedEvents.set(request.idempotencyKey, event);
        return event;
      }),
    };
    const invalidDefinition = { id: "workflow-1", tags: ["${("], steps: [] };
    const server = {
      workflows: {
        publishedForTeam: vi.fn(async () => [{ workflowId: "workflow-1", revision: 1, definition: invalidDefinition }]),
        getRevision: vi.fn(async () => invalidDefinition),
      },
      domainEventRepository,
      workflowRunAdmissions: admissions,
      secretRepository: {
        encryptValue: (value: string) => `cipher:${value}`,
        decryptValue: (value: string) => value.replace(/^cipher:/, ""),
      },
    };
    const parentJob = { id: 10, team_id: "team-1", status: "running" };
    const dispatch = { jobId: 10, stepId: "dispatch-step", target: "workflow-1", inputs: { source: "main" } };

    await expect(
      (WebhookServer.prototype as any).dispatchFromLease.call(server, parentJob, dispatch),
    ).rejects.toMatchObject({
      status: 400,
    });
    const outcome = await admissions.get("dispatch-event", -1);
    expect(outcome).toMatchObject({ status: "failed", admissionOutcome: "rejected", errorCode: "invalid_matrix" });

    await expect(
      (WebhookServer.prototype as any).dispatchFromLease.call(server, parentJob, dispatch),
    ).rejects.toMatchObject({
      status: 400,
    });
    expect(await admissions.get("dispatch-event", -1)).toMatchObject(outcome);
    expect(domainEventRepository.publish).toHaveBeenCalledOnce();

    testDb.database.close();
    testDb.database = new DatabaseSync(databasePath);
    expect(await new WorkflowRunAdmissionRepository().get("dispatch-event", -1)).toMatchObject(outcome);
  });
});
