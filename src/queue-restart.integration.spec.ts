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
        worker_id TEXT, report TEXT, started_at TEXT, finished_at TEXT, dispatch_key TEXT UNIQUE
      );
      CREATE TABLE workflow_revisions (workflow_id TEXT, revision INTEGER, normalized_json TEXT);
      CREATE TABLE recipe_versions (namespace TEXT, slug TEXT, version TEXT, revoked INTEGER);
      CREATE TABLE workflow_run_admissions (
        event_id TEXT, variant_index INTEGER, status TEXT, lease_token TEXT, lease_until TEXT
      );
      INSERT INTO teams VALUES ('team-1', NULL);
      INSERT INTO workflows VALUES ('workflow-1', 'team-1', 3);
      INSERT INTO workflow_revisions VALUES ('workflow-1', 3, '{}');
      INSERT INTO jobs (id, workflow_id, workflow_revision, required_tags, concurrency_key, payload, team_id, status)
        VALUES (41, 'workflow-1', 2, '[]', NULL, '{"inputs":{"source":"test"}}', 'team-1', 'success');
    `);

    const childId = await new QueueManager("test").restartJob(41);

    expect(childId).toBe(42);
    expect(
      testDb.database
        .prepare(
          "SELECT id, parentId, status, workflow_revision, team_id FROM jobs WHERE id = ?",
        )
        .get(childId),
    ).toMatchObject({
      id: 42,
      parentId: 41,
      status: "pending",
      workflow_revision: 3,
      team_id: "team-1",
    });
  });

  it.each([
    [
      "revoked root pin",
      '{"_recipeRef":{"namespace":"on","slug":"root","version":1}}',
      "root",
      1,
      1,
    ],
    [
      "missing nested pin",
      '{"_pinnedReferences":[{"namespace":"on","slug":"nested","version":2,"function":"main"}]}',
      "nested",
      2,
      -1,
    ],
  ])(
    "rejects restart when the active revision has a %s without creating partial state",
    async (_label, definition, slug, version, revoked) => {
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
      CREATE TABLE workflow_run_admissions (
        event_id TEXT, variant_index INTEGER, status TEXT, lease_token TEXT, lease_until TEXT
      );
      INSERT INTO teams VALUES ('team-1', NULL);
      INSERT INTO workflows VALUES ('workflow-1', 'team-1', 3);
      INSERT INTO workflow_revisions VALUES ('workflow-1', 3, '${definition}');
      INSERT INTO recipe_versions VALUES ('on', '${slug}', '${version}', ${revoked});
      INSERT INTO jobs (id, workflow_id, workflow_revision, required_tags, concurrency_key, payload, team_id, status)
        VALUES (41, 'workflow-1', 2, '[]', NULL, '{"inputs":{}}', 'team-1', 'success');
    `);
      await expect(new QueueManager("test").restartJob(41)).rejects.toThrow(
        "pinned recipe",
      );
      expect(
        testDb.database.prepare("SELECT COUNT(*) AS count FROM jobs").get(),
      ).toMatchObject({ count: 1 });
    },
  );

  it("blocks direct and dispatch admission of revoked root or missing nested pins without partial jobs", async () => {
    testDb.database = new DatabaseSync(":memory:");
    testDb.database.exec(`
      CREATE TABLE teams (id TEXT PRIMARY KEY, deleting_at TEXT);
      CREATE TABLE workflows (id TEXT PRIMARY KEY, team_id TEXT, active_revision INTEGER);
      CREATE TABLE jobs (
        id INTEGER PRIMARY KEY AUTOINCREMENT, parentId INTEGER, workflow_id TEXT, workflow_revision INTEGER,
        required_tags TEXT, concurrency_key TEXT, payload TEXT, team_id TEXT, status TEXT,
        worker_id TEXT, report TEXT, started_at TEXT, finished_at TEXT, dispatch_key TEXT UNIQUE
      );
      CREATE TABLE workflow_revisions (workflow_id TEXT, revision INTEGER, normalized_json TEXT);
      CREATE TABLE recipe_versions (namespace TEXT, slug TEXT, version TEXT, revoked INTEGER);
      CREATE TABLE workflow_run_admissions (
        event_id TEXT, variant_index INTEGER, status TEXT, lease_token TEXT, lease_until TEXT
      );
      INSERT INTO teams VALUES ('team-1', NULL);
      INSERT INTO workflows VALUES ('workflow-1', 'team-1', 3);
      INSERT INTO workflow_revisions VALUES ('workflow-1', 3,
        '{"_recipeRef":{"namespace":"on","slug":"root","version":1},"_pinnedReferences":[{"namespace":"on","slug":"nested","version":2}]}');
      INSERT INTO recipe_versions VALUES ('on', 'root', '1', 1);
      INSERT INTO jobs (id, workflow_id, workflow_revision, required_tags, concurrency_key, payload, team_id, status)
        VALUES (41, 'workflow-1', 2, '[]', NULL, '{"inputs":{}}', 'team-1', 'success');
    `);

    await expect(new QueueManager("test").enqueue("workflow-1", 3, { inputs: {} })).rejects.toThrow();
    expect(testDb.database.prepare("SELECT COUNT(*) AS count FROM jobs").get()).toMatchObject({ count: 1 });
    expect(
      await new QueueManager("test").enqueueDispatch(
        "workflow-1",
        3,
        { inputs: {} },
        [],
        "team-1",
        null,
        "dispatch-test",
      ),
    ).toBe(0);
    expect(testDb.database.prepare("SELECT COUNT(*) AS count FROM jobs").get()).toMatchObject({ count: 1 });
  });

  it.each([
    ["invalid JSON", "{"],
    ["malformed root pin metadata", '{"_recipeRef":"not-an-object"}'],
    ["malformed nested pin metadata", '{"_pinnedReferences":["not-an-object"]}'],
    ["non-array nested pin metadata", '{"_pinnedReferences":{"namespace":"on"}}'],
  ])("rejects admission with %s as a controlled error and leaves no job", async (_label, definition) => {
    testDb.database = new DatabaseSync(":memory:");
    testDb.database.exec(`
      CREATE TABLE teams (id TEXT PRIMARY KEY, deleting_at TEXT);
      CREATE TABLE workflows (id TEXT PRIMARY KEY, team_id TEXT, active_revision INTEGER);
      CREATE TABLE jobs (
        id INTEGER PRIMARY KEY AUTOINCREMENT, parentId INTEGER, workflow_id TEXT, workflow_revision INTEGER,
        required_tags TEXT, concurrency_key TEXT, payload TEXT, team_id TEXT, status TEXT,
        worker_id TEXT, report TEXT, started_at TEXT, finished_at TEXT, dispatch_key TEXT UNIQUE
      );
      CREATE TABLE workflow_revisions (workflow_id TEXT, revision INTEGER, normalized_json TEXT);
      CREATE TABLE recipe_versions (namespace TEXT, slug TEXT, version TEXT, revoked INTEGER);
      CREATE TABLE workflow_run_admissions (
        event_id TEXT, variant_index INTEGER, status TEXT, lease_token TEXT, lease_until TEXT
      );
      INSERT INTO teams VALUES ('team-1', NULL);
      INSERT INTO workflows VALUES ('workflow-1', 'team-1', 3);
      INSERT INTO workflow_revisions VALUES ('workflow-1', 3, '${definition}');
    `);
    const queue = new QueueManager("test");

    await expect(queue.enqueue("workflow-1", 3, { inputs: {} })).rejects.toThrow(
      "Workflow workspace is unavailable or being deleted",
    );
    expect(testDb.database.prepare("SELECT COUNT(*) AS count FROM jobs").get()).toMatchObject({ count: 0 });
    expect(await queue.enqueueDispatch("workflow-1", 3, { inputs: {} }, [], "team-1", null, "bad-pin")).toBe(0);
    expect(testDb.database.prepare("SELECT COUNT(*) AS count FROM jobs").get()).toMatchObject({ count: 0 });
  });

  it("does not admit a missing pinned revision; a pre-existing legacy job remains claimable and releasable", async () => {
    testDb.database = new DatabaseSync(":memory:");
    testDb.database.exec(`
      CREATE TABLE teams (id TEXT PRIMARY KEY, deleting_at TEXT);
      CREATE TABLE workflows (id TEXT PRIMARY KEY, team_id TEXT, active_revision INTEGER);
      CREATE TABLE jobs (
        id INTEGER PRIMARY KEY AUTOINCREMENT, parentId INTEGER, workflow_id TEXT, workflow_revision INTEGER,
        required_tags TEXT, concurrency_key TEXT, payload TEXT, team_id TEXT, status TEXT,
        worker_id TEXT, report TEXT, started_at TEXT, finished_at TEXT, created_at TEXT DEFAULT CURRENT_TIMESTAMP,
        updated_at TEXT, lease_id TEXT, lease_token_hash TEXT, lease_expires_at TEXT
      );
      CREATE TABLE workflow_revisions (workflow_id TEXT, revision INTEGER, normalized_json TEXT);
      CREATE TABLE recipe_versions (namespace TEXT, slug TEXT, version TEXT, revoked INTEGER);
      CREATE TABLE workflow_run_admissions (
        event_id TEXT, variant_index INTEGER, status TEXT, lease_token TEXT, lease_until TEXT
      );
      INSERT INTO teams VALUES ('team-1', NULL);
      INSERT INTO workflows VALUES ('workflow-1', 'team-1', 3);
      INSERT INTO jobs (workflow_id, workflow_revision, required_tags, concurrency_key, payload, team_id, status)
        VALUES ('workflow-1', 2, '[]', '', '{"inputs":{}}', 'team-1', 'pending');
    `);
    const queue = new QueueManager("test-worker");

    await expect(queue.enqueue("workflow-1", 3, { inputs: {} })).rejects.toThrow();
    expect(testDb.database.prepare("SELECT COUNT(*) AS count FROM jobs").get()).toMatchObject({ count: 1 });
    const claimed = await queue.claimNextJob();
    expect(claimed).toMatchObject({ workflow_id: "workflow-1", workflow_revision: 2, status: "running" });
    await queue.releaseJob(claimed!.id);
    expect(testDb.database.prepare("SELECT status, worker_id FROM jobs").get()).toMatchObject({
      status: "pending",
      worker_id: null,
    });
  });
});
