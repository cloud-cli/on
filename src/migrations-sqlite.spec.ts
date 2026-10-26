import { beforeEach, describe, expect, it, vi } from "vitest";
import { DatabaseSync } from "node:sqlite";
import { runMigrations } from "./migrations.js";

vi.mock("./db-client.js", () => {
  let database = new DatabaseSync(":memory:");
  let failAdmissionMarkerOnce = false;
  const execute = (sql: string, values: unknown[] = []) => database.prepare(sql).run(...(values as any[]));
  const module = {
    all: vi.fn(async (sql: string, values: unknown[] = []) => database.prepare(sql).all(...(values as any[]))),
    get: vi.fn(async (sql: string, values: unknown[] = []) => database.prepare(sql).get(...(values as any[]))),
    run: vi.fn(async (sql: string, values: unknown[] = []) => {
      if (
        failAdmissionMarkerOnce &&
        sql.includes("INSERT INTO schema_migrations") &&
        values[0] === "023_workflow_run_admission_retry_schedule"
      ) {
        failAdmissionMarkerOnce = false;
        throw new Error("simulated migration marker interruption");
      }
      return execute(sql, values);
    }),
    exec: vi.fn(async (sql: string) => database.exec(sql)),
    transaction: vi.fn(async (statements: Array<{ s: string; d?: unknown[]; m?: string }>) => {
      database.exec("BEGIN");
      try {
        for (const statement of statements) {
          if (statement.m === "exec") {
            database.exec(statement.s);
          } else {
            execute(statement.s, statement.d || []);
          }
        }
        database.exec("COMMIT");
      } catch (error) {
        database.exec("ROLLBACK");
        throw error;
      }
    }),
  };
  return {
    default: module,
    __test: {
      currentDatabase: () => database,
      reset: () => {
        database.close();
        database = new DatabaseSync(":memory:");
        database.exec("PRAGMA foreign_keys = ON");
        failAdmissionMarkerOnce = false;
      },
      failNextAdmissionMarker: () => {
        failAdmissionMarkerOnce = true;
      },
    },
  };
});

const dbTestHooks = ((await import("./db-client.js")) as any).__test;

const baselineVersions = [
  "001_add_workflow_enabled",
  "002_add_push_subscriptions",
  "003_add_push_delivery_history",
  "004_add_ai_requests",
  "005_add_teams",
  "006_scope_push_subscriptions_to_teams",
  "007_scope_api_keys_to_teams",
  "008_workflows_team_foreign_key",
  "009_workflow_definition_ids",
  "010_unified_principals_and_permissions",
  "011_workspace_deletion_fence",
  "012_retire_flow_system_principals",
  "013_oidc_subject_workspace_invitations",
  "014_incoming_event_inbox",
];

function createPreV3Database(existingData: boolean) {
  const database = dbTestHooks.currentDatabase() as DatabaseSync;
  database.exec(`
    CREATE TABLE schema_migrations (version TEXT PRIMARY KEY, applied_at TEXT DEFAULT CURRENT_TIMESTAMP);
    CREATE TABLE teams (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      webhook_token TEXT NOT NULL UNIQUE,
      created_at TEXT DEFAULT CURRENT_TIMESTAMP,
      deleting_at TEXT
    );
    CREATE TABLE team_members (
      team_id TEXT NOT NULL REFERENCES teams(id) ON DELETE CASCADE,
      subject TEXT NOT NULL,
      role TEXT NOT NULL,
      created_at TEXT DEFAULT CURRENT_TIMESTAMP,
      PRIMARY KEY (team_id, subject)
    );
    CREATE TABLE workflows (
      id TEXT PRIMARY KEY,
      team_id TEXT NOT NULL REFERENCES teams(id),
      definition_id TEXT,
      source_yaml TEXT NOT NULL DEFAULT 'name: legacy',
      enabled INTEGER NOT NULL DEFAULT 1
    );
    CREATE TABLE jobs (
      id INTEGER PRIMARY KEY,
      team_id TEXT NOT NULL REFERENCES teams(id)
    );
  `);
  const insertVersion = database.prepare("INSERT INTO schema_migrations(version) VALUES (?)");
  for (const version of baselineVersions) {
    insertVersion.run(version);
  }
  if (existingData) {
    database.exec(`
      INSERT INTO teams(id, name, webhook_token) VALUES ('team-a', 'Legacy team', 'token-a');
      INSERT INTO team_members(team_id, subject, role) VALUES ('team-a', 'human-a', 'admin');
      INSERT INTO workflows(id, team_id, definition_id) VALUES ('workflow-a', 'team-a', 'legacy-flow');
      INSERT INTO jobs(id, team_id) VALUES (101, 'team-a');
    `);
  }
}

describe("v3 migrations against SQLite", () => {
  beforeEach(() => dbTestHooks.reset());

  it("applies to a fresh pre-v3 schema and remains repeatable", async () => {
    createPreV3Database(false);

    await expect(runMigrations()).resolves.toBeUndefined();
    await expect(runMigrations()).resolves.toBeUndefined();

    const database = dbTestHooks.currentDatabase() as DatabaseSync;
    const versions = database.prepare("SELECT version FROM schema_migrations ORDER BY version").all() as Array<{
      version: string;
    }>;
    expect(versions.map(({ version }) => version)).toContain("023_workflow_run_admission_retry_schedule");
    expect(versions.map(({ version }) => version)).toContain("024_step_attempt_start_markers");
    expect(versions.map(({ version }) => version)).toContain("026_durable_event_sequence");
    expect(versions.map(({ version }) => version)).toContain("027_channel_event_history_index");
    expect(versions.map(({ version }) => version)).toContain("028_workflow_run_plan_ready");
    expect(versions.map(({ version }) => version)).toContain("029_step_attempt_identity");
    expect(versions.map(({ version }) => version)).toContain("030_domain_event_delivery_invocation_link");
    expect(versions.map(({ version }) => version)).toContain("031_stream_threads");
    expect(versions.map(({ version }) => version)).toContain("032_step_attempt_snapshots");
    expect(versions.map(({ version }) => version)).toContain("033_stream_event_bindings");
    expect(versions.map(({ version }) => version)).toContain("033_stream_event_bindings");
    expect(database.prepare("PRAGMA table_info(step_execution_attempt_starts)").all()).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ name: "started_at" }),
        expect.objectContaining({ name: "attempt_id" }),
      ]),
    );
    expect(database.prepare("PRAGMA table_info(step_execution_attempts)").all()).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ name: "attempt_id" }),
        expect.objectContaining({ name: "snapshot_json" }),
      ]),
    );
    expect(database.prepare("PRAGMA table_info(domain_event_deliveries)").all()).toEqual(
      expect.arrayContaining([expect.objectContaining({ name: "invocation_id" })]),
    );
    expect(database.prepare("PRAGMA table_info(channel_threads)").all()).toEqual(
      expect.arrayContaining([expect.objectContaining({ name: "created_by" })]),
    );
    expect(database.prepare("PRAGMA table_info(channel_thread_messages)").all()).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ name: "thread_id" }),
        expect.objectContaining({ name: "body_json" }),
      ]),
    );
    expect(database.prepare("PRAGMA table_info(stream_event_bindings)").all()).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ name: "team_id" }),
        expect.objectContaining({ name: "stream_id" }),
        expect.objectContaining({ name: "event_id" }),
      ]),
    );
    expect(database.prepare("PRAGMA table_info(workflow_run_admissions)").all()).toEqual(
      expect.arrayContaining([expect.objectContaining({ name: "retry_after" })]),
    );
    expect(database.prepare("PRAGMA table_info(workflow_run_admission_plans)").all()).toEqual(
      expect.arrayContaining([expect.objectContaining({ name: "plan_hash" })]),
    );
    expect(database.prepare("PRAGMA table_info(domain_event_subscriptions)").all()).toEqual(
      expect.arrayContaining([expect.objectContaining({ name: "high_water_event_sequence" })]),
    );
    expect(
      database
        .prepare("SELECT name FROM sqlite_master WHERE type = 'index' AND name = 'workflow_run_admissions_retry'")
        .get(),
    ).toBeTruthy();
    expect(database.prepare("PRAGMA foreign_key_check").all()).toEqual([]);
    expect(
      database
        .prepare("SELECT name FROM sqlite_master WHERE type = 'index' AND name = 'idx_domain_events_channel_sequence'")
        .get(),
    ).toBeTruthy();
  });

  it("assigns durable increasing event sequences independently of SQLite rowids", async () => {
    createPreV3Database(true);
    await runMigrations();
    const database = dbTestHooks.currentDatabase() as DatabaseSync;
    const insert = database.prepare(`
      INSERT INTO domain_events
        (id, team_id, type, schema_version, source, occurred_at, recorded_at, data_json)
      VALUES (?, 'team-a', 'channel.message', 1, 'test', '2026-01-01', '2026-01-01', '{}')
    `);
    insert.run("event-a");
    insert.run("event-b");
    const before = database.prepare("SELECT id, sequence FROM domain_events ORDER BY sequence").all();
    database.exec("VACUUM");
    const after = database.prepare("SELECT id, sequence FROM domain_events ORDER BY sequence").all();
    expect(after).toEqual(before);

    insert.run("event-c");
    const last = database.prepare("SELECT id, sequence FROM domain_events ORDER BY sequence DESC LIMIT 1").get();
    expect(last).toMatchObject({ id: "event-c", sequence: 3 });
  });

  it("keeps legacy Stream messages separate from explicit Thread conversations", async () => {
    createPreV3Database(true);
    await runMigrations();
    const database = dbTestHooks.currentDatabase() as DatabaseSync;
    database.exec(`
      INSERT INTO channels(id, team_id, name) VALUES ('stream-a', 'team-a', 'Operations');
      INSERT INTO channel_messages(id, team_id, channel_id, author, body_json)
        VALUES ('legacy-message', 'team-a', 'stream-a', 'human-a', '{"text":"legacy stream note"}');
      INSERT INTO channel_threads(id, team_id, channel_id, title, created_by)
        VALUES ('thread-a', 'team-a', 'stream-a', 'Investigate alert', 'human-a');
      INSERT INTO channel_thread_messages(id, team_id, channel_id, thread_id, author, body_json)
        VALUES ('thread-message', 'team-a', 'stream-a', 'thread-a', 'human-a', '{"text":"thread reply"}');
    `);

    expect(database.prepare("SELECT id, body_json FROM channel_messages").all()).toEqual([
      { id: "legacy-message", body_json: '{"text":"legacy stream note"}' },
    ]);
    expect(database.prepare("SELECT id, thread_id, body_json FROM channel_thread_messages").all()).toEqual([
      { id: "thread-message", thread_id: "thread-a", body_json: '{"text":"thread reply"}' },
    ]);
    expect(database.prepare("PRAGMA foreign_key_check").all()).toEqual([]);
  });

  it("uses the channel history expression index without changing ordered cursor pages", async () => {
    createPreV3Database(true);
    const database = dbTestHooks.currentDatabase() as DatabaseSync;
    database.exec("INSERT INTO teams(id, name, webhook_token) VALUES ('team-b', 'Other team', 'token-b')");
    await runMigrations();
    const insert = database.prepare(`
      INSERT INTO domain_events
        (id, team_id, type, schema_version, source, occurred_at, recorded_at, data_json, sequence)
      VALUES (?, ?, 'channel.message', 1, 'test', '2026-01-01', '2026-01-01', ?, ?)
    `);
    const rows = [
      ["a-one", "team-a", '{"channelId":"one","n":1}', 1],
      ["b-one", "team-b", '{"channelId":"one","n":2}', 2],
      ["a-two", "team-a", '{"channelId":"two","n":3}', 3],
      ["a-one-2", "team-a", '{"channelId":"one","n":4}', 4],
      ["b-two", "team-b", '{"channelId":"two","n":5}', 5],
      ["a-one-3", "team-a", '{"channelId":"one","n":6}', 6],
    ];
    for (const row of rows) {
      insert.run(...row);
    }
    const query = `SELECT sequence, id, team_id, type, schema_version, source, occurred_at, recorded_at,
      correlation_id, causation_id, idempotency_key, data_json FROM domain_events
      WHERE team_id = ? AND json_extract(data_json, '$.channelId') = ? AND sequence > ?
      ORDER BY sequence LIMIT ?`;
    const plan = database.prepare(`EXPLAIN QUERY PLAN ${query}`).all("team-a", "one", 0, 2) as Array<{
      detail: string;
    }>;
    expect(plan.some(({ detail }) => detail.includes("idx_domain_events_channel_sequence"))).toBe(true);
    expect(plan.some(({ detail }) => detail.includes("USE TEMP B-TREE FOR ORDER BY"))).toBe(false);
    const first = database.prepare(query).all("team-a", "one", 0, 2);
    expect(first.map((row: any) => row.id)).toEqual(["a-one", "a-one-2"]);
    const next = database.prepare(query).all("team-a", "one", 4, 2);
    expect(next.map((row: any) => row.id)).toEqual(["a-one-3"]);
  });

  it("preserves legacy workspace, workflow, membership and job rows", async () => {
    createPreV3Database(true);

    await expect(runMigrations()).resolves.toBeUndefined();

    const database = dbTestHooks.currentDatabase() as DatabaseSync;
    expect(database.prepare("SELECT id, name FROM teams WHERE id = 'team-a'").get()).toEqual({
      id: "team-a",
      name: "Legacy team",
    });
    expect(database.prepare("SELECT id, definition_id FROM workflows WHERE id = 'workflow-a'").get()).toEqual({
      id: "workflow-a",
      definition_id: "legacy-flow",
    });
    expect(database.prepare("SELECT team_id, subject FROM team_members WHERE subject = 'human-a'").get()).toEqual({
      team_id: "team-a",
      subject: "human-a",
    });
    expect(database.prepare("SELECT id, team_id FROM jobs WHERE id = 101").get()).toEqual({
      id: 101,
      team_id: "team-a",
    });
    expect(database.prepare("PRAGMA foreign_key_check").all()).toEqual([]);
  });

  it("preserves preexisting admission rows and reruns the plan-ready migration", async () => {
    createPreV3Database(true);
    await runMigrations();
    const database = dbTestHooks.currentDatabase() as DatabaseSync;
    database.exec(`INSERT INTO workflow_run_admissions
      (event_id, team_id, workflow_id, revision, variant_index, matrix_json, tags_json, status)
      VALUES ('legacy-event', 'team-a', 'workflow-a', 1, 0, '{}', '[]', 'pending')`);
    await runMigrations();
    expect(database.prepare("SELECT event_id, variant_index, status FROM workflow_run_admissions").get()).toEqual({
      event_id: "legacy-event",
      variant_index: 0,
      status: "pending",
    });
    expect(database.prepare("SELECT COUNT(*) AS count FROM workflow_run_admission_plans").get()).toEqual({ count: 0 });
  });

  it("recovers when migration 023 applied its schema but could not record its version", async () => {
    createPreV3Database(true);
    dbTestHooks.failNextAdmissionMarker();

    await expect(runMigrations()).rejects.toThrow("simulated migration marker interruption");
    const database = dbTestHooks.currentDatabase() as DatabaseSync;
    expect(
      (database.prepare("PRAGMA table_info(workflow_run_admissions)").all() as Array<{ name: string }>).some(
        ({ name }) => name === "retry_after",
      ),
    ).toBe(true);
    expect(
      database
        .prepare("SELECT name FROM sqlite_master WHERE type = 'index' AND name = 'workflow_run_admissions_retry'")
        .get(),
    ).toBeTruthy();
    expect(
      database
        .prepare("SELECT 1 FROM schema_migrations WHERE version = '023_workflow_run_admission_retry_schedule'")
        .get(),
    ).toBeUndefined();

    await expect(runMigrations()).resolves.toBeUndefined();
    await expect(runMigrations()).resolves.toBeUndefined();
    expect(
      database
        .prepare(
          "SELECT COUNT(*) AS count FROM schema_migrations WHERE version = '023_workflow_run_admission_retry_schedule'",
        )
        .get(),
    ).toEqual({ count: 1 });
    expect(database.prepare("PRAGMA foreign_key_check").all()).toEqual([]);
  });

  it("keeps immutable start markers and the start-marker schema across migration reruns", async () => {
    createPreV3Database(true);
    await runMigrations();
    const database = dbTestHooks.currentDatabase() as DatabaseSync;
    database.exec(
      "INSERT INTO step_execution_attempt_starts(team_id, job_id, step_id, attempt, started_at) VALUES ('team-a', 101, 'build', 1, '2026-01-01T00:00:00Z')",
    );
    await runMigrations();
    expect(() => database.prepare("UPDATE step_execution_attempt_starts SET started_at = 'changed'").run()).toThrow(
      "step attempt start markers are immutable",
    );
    expect(
      database.prepare("SELECT team_id, job_id, step_id, attempt, started_at FROM step_execution_attempt_starts").get(),
    ).toEqual({
      team_id: "team-a",
      job_id: 101,
      step_id: "build",
      attempt: 1,
      started_at: "2026-01-01T00:00:00Z",
    });
    expect(database.prepare("PRAGMA foreign_key_check").all()).toEqual([]);
  });
});
