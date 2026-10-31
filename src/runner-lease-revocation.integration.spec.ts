import { afterEach, describe, expect, it, vi } from "vitest";
import { DatabaseSync } from "node:sqlite";

const testDb = vi.hoisted(() => ({ database: null as DatabaseSync | null }));
vi.mock("./db-client.js", () => ({
  default: {
    get: async (sql: string, values: unknown[] = []) =>
      testDb.database!.prepare(sql).get(...(values as any[])),
    run: async (sql: string, values: unknown[] = []) =>
      testDb.database!.prepare(sql).run(...(values as any[])),
    all: async (sql: string, values: unknown[] = []) =>
      testDb.database!.prepare(sql).all(...(values as any[])),
    exec: async (sql: string) => testDb.database!.exec(sql),
  },
}));

import { QueueManager } from "./queue.js";
import { DomainEventRepository } from "./domain-event-repository.js";

process.env.RUNNER_MASTER_KEY ||= "unit-test-runner-master-key";

afterEach(() => {
  testDb.database?.close();
  testDb.database = null;
});

describe("runner lease revocation SQLite integration", () => {
  it("finishes revoked jobs in team and runner scopes and projects invocation completion", async () => {
    testDb.database = new DatabaseSync(":memory:");
    testDb.database.exec(`
      CREATE TABLE jobs (
        id INTEGER PRIMARY KEY, team_id TEXT, status TEXT, worker_id TEXT, lease_id TEXT,
        lease_completed INTEGER DEFAULT 0, lease_fenced INTEGER DEFAULT 0,
        updated_at TEXT, finished_at TEXT
      );
      CREATE TABLE domain_events (
        id TEXT, team_id TEXT, type TEXT, recorded_at TEXT, data_json TEXT
      );
      CREATE TABLE workflow_run_admissions (
        team_id TEXT, event_id TEXT, variant_index INTEGER, status TEXT,
        admission_outcome TEXT, error_code TEXT, job_id INTEGER
      );
      INSERT INTO jobs (id, team_id, status, worker_id, lease_id) VALUES
        (1, 'team-a', 'running', 'runner-a', 'lease-a'),
        (2, 'team-b', 'running', 'runner-a', 'lease-b'),
        (3, 'team-a', 'running', 'runner-b', 'lease-c'),
        (4, 'team-a', 'running', 'runner-a', 'lease-d');
      INSERT INTO domain_events VALUES
        ('event-a', 'team-a', 'workflow.run.requested', '2026-01-01T00:00:00Z', '{"workflowId":"deploy","revision":1,"invocationId":"invoke-a"}'),
        ('event-b', 'team-b', 'workflow.run.requested', '2026-01-01T00:00:00Z', '{"workflowId":"deploy","revision":1,"invocationId":"invoke-b"}');
      INSERT INTO workflow_run_admissions VALUES
        ('team-a', 'event-a', 0, 'admitted', 'accepted', NULL, 1),
        ('team-b', 'event-b', 0, 'admitted', 'accepted', NULL, 2);
    `);
    const queue = new QueueManager("runner-a");

    await queue.revokeRunnerLeasesForTeam("runner-a", "team-a");
    const teamInvocation =
      await new DomainEventRepository().getWorkflowInvocationForTeam(
        "team-a",
        "invoke-a",
      );
    expect(teamInvocation?.variants[0]).toMatchObject({
      jobStatus: "cancelled",
      completedAt: expect.any(String),
    });
    const teamFinishedAt = testDb.database
      .prepare("SELECT finished_at FROM jobs WHERE id = 1")
      .get() as { finished_at: string };

    testDb.database
      .prepare("UPDATE jobs SET finished_at = 'preserved-time' WHERE id = 2")
      .run();
    await queue.revokeRunnerLeases("runner-a");
    const runnerInvocation =
      await new DomainEventRepository().getWorkflowInvocationForTeam(
        "team-b",
        "invoke-b",
      );
    expect(runnerInvocation?.variants[0]).toMatchObject({
      jobStatus: "cancelled",
      completedAt: "preserved-time",
    });
    const rows = testDb.database
      .prepare(
        "SELECT id, status, finished_at, lease_fenced FROM jobs ORDER BY id",
      )
      .all() as Array<{
      id: number;
      status: string;
      finished_at: string | null;
      lease_fenced: number;
    }>;
    expect(rows[0]).toMatchObject({
      status: "cancelled",
      finished_at: teamFinishedAt.finished_at,
      lease_fenced: 1,
    });
    expect(rows[1]).toMatchObject({
      status: "cancelled",
      finished_at: "preserved-time",
      lease_fenced: 1,
    });
    expect(rows[2]).toMatchObject({
      status: "running",
      finished_at: null,
      lease_fenced: 0,
    });
    expect(rows[3]).toMatchObject({
      status: "cancelled",
      finished_at: expect.any(String),
      lease_fenced: 1,
    });
  });
});
