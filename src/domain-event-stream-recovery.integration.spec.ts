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
      CREATE TABLE workflow_run_admissions (team_id TEXT, event_id TEXT, job_id INTEGER);
      INSERT INTO channels VALUES ('stream-a', 'team-a'), ('stream-a', 'team-b');
      INSERT INTO domain_events VALUES
        (1, 'event-a1', 'team-a', 'audit.created', 1, 'test', '2026-01-01T00:00:00Z', '2026-01-01T00:00:00Z', NULL, NULL, NULL, '{}'),
        (2, 'event-b1', 'team-b', 'audit.created', 1, 'test', '2026-01-01T00:00:00Z', '2026-01-01T00:00:00Z', NULL, NULL, NULL, '{}'),
        (3, 'event-a2', 'team-a', 'audit.created', 1, 'test', '2026-01-02T00:00:00Z', '2026-01-02T00:00:00Z', NULL, NULL, NULL, '{}'),
        (4, 'event-a3', 'team-a', 'audit.created', 1, 'test', '2026-01-03T00:00:00Z', '2026-01-03T00:00:00Z', NULL, NULL, NULL, '{}');
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
    expect(resumed.events.some(({ id }) => id === "event-b1")).toBe(false);
    await expect(afterRestart.listChannelEvents("team-b", "stream-a", 10, firstPage.nextCursor!)).rejects.toThrow(
      "Invalid event cursor",
    );
  });
});
