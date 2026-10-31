import { afterEach, describe, expect, it, vi } from "vitest";
import { DatabaseSync } from "node:sqlite";
import FS from "node:fs";
import OS from "node:os";
import Path from "node:path";

const testDb = vi.hoisted(() => ({ database: null as DatabaseSync | null }));
vi.mock("./db-client.js", () => ({
  default: {
    get: async (sql: string, values: unknown[] = []) => testDb.database!.prepare(sql).get(...(values as any[])),
    run: async (sql: string, values: unknown[] = []) => testDb.database!.prepare(sql).run(...(values as any[])),
    all: async (sql: string, values: unknown[] = []) => testDb.database!.prepare(sql).all(...(values as any[])),
  },
}));

import { QueueManager } from "./queue.js";

const directory = FS.mkdtempSync(Path.join(OS.tmpdir(), "attempt-interruption-"));
const databasePath = Path.join(directory, "runner.sqlite");

afterEach(() => {
  testDb.database?.close();
  testDb.database = null;
  FS.rmSync(directory, { recursive: true, force: true });
});

describe("interrupted step attempt persistence and recovery", () => {
  it("keeps an immutable start visible after restart without inventing completion", async () => {
    testDb.database = new DatabaseSync(databasePath);
    testDb.database.exec(`
      CREATE TABLE teams (id TEXT PRIMARY KEY, deleting_at TEXT);
      CREATE TABLE jobs (
        id INTEGER PRIMARY KEY, team_id TEXT NOT NULL, status TEXT NOT NULL, workflow_id TEXT NOT NULL,
        workflow_revision INTEGER NOT NULL, required_tags TEXT NOT NULL DEFAULT '[]', concurrency_key TEXT,
        payload TEXT NOT NULL, worker_id TEXT, report TEXT, created_at TEXT DEFAULT CURRENT_TIMESTAMP,
        started_at TEXT, updated_at TEXT, finished_at TEXT, lease_id TEXT, lease_token_hash TEXT,
        lease_expires_at TEXT, lease_fenced INTEGER DEFAULT 0, lease_completed INTEGER DEFAULT 0
      );
      CREATE TABLE step_execution_attempt_starts (
        id INTEGER PRIMARY KEY, team_id TEXT NOT NULL, job_id INTEGER NOT NULL, step_id TEXT NOT NULL,
        attempt INTEGER NOT NULL, started_at TEXT NOT NULL, attempt_id TEXT NOT NULL,
        UNIQUE(job_id, step_id, attempt)
      );
      CREATE TABLE step_execution_attempts (
        id INTEGER PRIMARY KEY, team_id TEXT NOT NULL, job_id INTEGER NOT NULL, step_id TEXT NOT NULL,
        attempt INTEGER NOT NULL, status TEXT NOT NULL, started_at TEXT NOT NULL, completed_at TEXT NOT NULL,
        duration_ms INTEGER NOT NULL, exit_code INTEGER, error TEXT, log_content TEXT NOT NULL,
        attempt_id TEXT NOT NULL, snapshot_json TEXT, UNIQUE(job_id, step_id, attempt)
      );
      INSERT INTO teams VALUES ('team-a', NULL);
      INSERT INTO jobs (id, team_id, status, workflow_id, workflow_revision, payload, worker_id, lease_id,
        lease_token_hash, lease_expires_at, started_at)
      VALUES (73, 'team-a', 'running', 'deploy', 1, '{}', 'dead-worker', 'lease-old', 'hash-old',
        datetime('now', '-2 hours'), datetime('now', '-2 hours'));
    `);
    const queue = new QueueManager("dead-worker");
    const marker = { jobId: 73, stepId: "publish", attempt: 1, startedAt: "2026-10-31T10:00:00.000Z", attemptId: "attempt-uuid" };
    await queue.saveStepAttemptStart(marker);
    testDb.database.close();

    testDb.database = new DatabaseSync(databasePath);
    const reopenedQueue = new QueueManager("replacement-worker");
    const recoveredEvidence = await reopenedQueue.getStepAttemptsForTeam("team-a", 73);
    expect(recoveredEvidence).toHaveLength(1);
    expect(recoveredEvidence[0]).toMatchObject({
      step_id: "publish", attempt: 1, attempt_id: "attempt-uuid", started_at: marker.startedAt,
      status: "interrupted_or_unknown", lifecycle_status: "started", completed_at: null,
    });
    expect(testDb.database.prepare("SELECT COUNT(*) AS count FROM step_execution_attempts").get()).toMatchObject({ count: 0 });

    // Recovery makes the job claimable even though the recorded side effect's outcome is unknown.
    await reopenedQueue.clearStaleJobs();
    const reclaimed = await reopenedQueue.claimNextJob();
    expect(reclaimed).toMatchObject({ id: 73, status: "running", worker_id: "replacement-worker" });
    expect(await reopenedQueue.getStepAttemptsForTeam("team-a", 73)).toMatchObject([
      { status: "interrupted_or_unknown", lifecycle_status: "started", attempt_id: "attempt-uuid" },
    ]);
    expect(testDb.database.prepare("SELECT COUNT(*) AS count FROM step_execution_attempts").get()).toMatchObject({ count: 0 });
    await expect(reopenedQueue.saveStepAttemptStart({ ...marker, attemptId: "different-attempt" })).rejects.toThrow(
      "Step attempt start already exists or could not be persisted",
    );
  });
});
