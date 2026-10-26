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
    },
  };
});

import { DomainEventRepository } from "./domain-event-repository.js";

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
      CREATE TABLE jobs (id INTEGER PRIMARY KEY, team_id TEXT, status TEXT);
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
      INSERT INTO jobs VALUES (42, 'team-a', 'running');
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
});
