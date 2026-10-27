import { afterEach, describe, expect, it, vi } from "vitest";
import { DatabaseSync } from "node:sqlite";

const testDb = vi.hoisted(() => ({ database: null as DatabaseSync | null }));
vi.mock("./db-client.js", () => ({
  default: {
    get: async (sql: string, values: unknown[] = []) => testDb.database!.prepare(sql).get(...(values as any[])),
    run: async (sql: string, values: unknown[] = []) => testDb.database!.prepare(sql).run(...(values as any[])),
    all: async (sql: string, values: unknown[] = []) => testDb.database!.prepare(sql).all(...(values as any[])),
    exec: async (sql: string) => testDb.database!.exec(sql),
  },
}));

import { QueueManager } from "./queue.js";

process.env.RUNNER_MASTER_KEY ||= "unit-test-runner-master-key";

afterEach(() => {
  testDb.database?.close();
  testDb.database = null;
});

describe("QueueManager.restartJob SQLite integration", () => {
  it("creates a child job with its parent ID from the real joined schema", async () => {
    testDb.database = new DatabaseSync(":memory:");
    testDb.database.exec(`
      CREATE TABLE teams (id TEXT PRIMARY KEY, deleting_at TEXT);
      CREATE TABLE workflows (id TEXT PRIMARY KEY, team_id TEXT, active_revision INTEGER);
      CREATE TABLE jobs (
        id INTEGER PRIMARY KEY AUTOINCREMENT, parentId INTEGER, workflow_id TEXT, workflow_revision INTEGER,
        required_tags TEXT, concurrency_key TEXT, payload TEXT, team_id TEXT, status TEXT,
        worker_id TEXT, report TEXT, started_at TEXT, finished_at TEXT
      );
      CREATE TABLE workflow_revisions (workflow_id TEXT, revision INTEGER, normalized_json TEXT);
      CREATE TABLE recipe_versions (namespace TEXT, slug TEXT, version TEXT, revoked INTEGER);
      INSERT INTO teams VALUES ('team-1', NULL);
      INSERT INTO workflows VALUES ('workflow-1', 'team-1', 3);
      INSERT INTO jobs (id, workflow_id, workflow_revision, required_tags, concurrency_key, payload, team_id, status)
        VALUES (41, 'workflow-1', 2, '[]', NULL, '{"inputs":{"source":"test"}}', 'team-1', 'success');
    `);

    const childId = await new QueueManager("test").restartJob(41);

    expect(childId).toBe(42);
    expect(
      testDb.database
        .prepare("SELECT id, parentId, status, workflow_revision, team_id FROM jobs WHERE id = ?")
        .get(childId),
    ).toMatchObject({
      id: 42,
      parentId: 41,
      status: "pending",
      workflow_revision: 3,
      team_id: "team-1",
    });
  });
});
