import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it, vi } from "vitest";
import { runMigrations } from "./migrations.js";

vi.mock("./db-client.js", () => {
  let database = new DatabaseSync(":memory:");
  let failOutcomeMarker = false;
  const module = {
    all: vi.fn(async (sql: string) => database.prepare(sql).all()),
    get: vi.fn(async (sql: string) => database.prepare(sql).get()),
    run: vi.fn(async (sql: string, values: unknown[] = []) => {
      if (failOutcomeMarker && sql.includes("INSERT INTO schema_migrations")) {
        failOutcomeMarker = false;
        throw new Error("injected migration marker failure");
      }
      return database.prepare(sql).run(...(values as any[]));
    }),
    exec: vi.fn(async (sql: string) => database.exec(sql)),
  };
  return {
    default: module,
    __test: {
      database: () => database,
      failNextOutcomeMarker: () => {
        failOutcomeMarker = true;
      },
      reset: () => {
        database.close();
        database = new DatabaseSync(":memory:");
        failOutcomeMarker = false;
      },
    },
  };
});

const hooks = ((await import("./db-client.js")) as any).__test;
const database = () => hooks.database() as DatabaseSync;
const appliedVersions = [
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
  "015_typed_domain_events",
  "016_domain_event_deliveries",
  "017_domain_event_delivery_fences",
  "018_domain_event_subscription_identity",
  "019_durable_channel_history",
  "020_durable_step_attempts",
  "021_agent_workflow_grants",
  "022_workflow_run_admission",
  "023_workflow_run_admission_retry_schedule",
  "024_step_attempt_start_markers",
  "026_durable_event_sequence",
  "027_channel_event_history_index",
  "028_workflow_run_plan_ready",
  "029_step_attempt_identity",
  "030_domain_event_delivery_invocation_link",
  "031_stream_threads",
  "032_step_attempt_snapshots",
  "033_stream_event_bindings",
  "034_stream_event_binding_integrity",
  "035_domain_event_fanout_outcomes",
];

describe("workflow run admission outcome migration recovery", () => {
  afterEach(() => hooks.reset());

  it("recovers when the 036 marker write fails after schema and backfill changes", async () => {
    database().exec(`CREATE TABLE schema_migrations (version TEXT PRIMARY KEY);
      CREATE TABLE workflow_run_admissions (
        event_id TEXT NOT NULL, team_id TEXT NOT NULL, workflow_id TEXT NOT NULL, revision INTEGER NOT NULL,
        variant_index INTEGER NOT NULL, matrix_json TEXT NOT NULL, tags_json TEXT NOT NULL,
        status TEXT NOT NULL DEFAULT 'pending' CHECK(status IN ('pending','claimed','admitted','failed')),
        lease_token TEXT, lease_until TEXT, job_id INTEGER, error_code TEXT, updated_at TEXT DEFAULT CURRENT_TIMESTAMP,
        retry_after TEXT, PRIMARY KEY(event_id, variant_index)
      );`);
    const marker = database().prepare("INSERT INTO schema_migrations(version) VALUES (?)");
    for (const version of appliedVersions) {marker.run(version);}
    database().exec(`INSERT INTO workflow_run_admissions
      (event_id, team_id, workflow_id, revision, variant_index, matrix_json, tags_json, status, job_id)
      VALUES ('event', 'team', 'workflow', 4, 0, '{"x":1}', '["tag"]', 'admitted', 17)`);
    hooks.failNextOutcomeMarker();

    await expect(runMigrations()).rejects.toThrow("injected migration marker failure");
    expect(database().prepare("SELECT admission_outcome FROM workflow_run_admissions").get()).toEqual({
      admission_outcome: "accepted",
    });
    expect(
      database()
        .prepare("SELECT COUNT(*) AS count FROM schema_migrations WHERE version = ?")
        .get("036_workflow_run_admission_outcomes"),
    ).toEqual({ count: 0 });

    await runMigrations();
    expect(
      database().prepare("SELECT admission_outcome, job_id, matrix_json FROM workflow_run_admissions").get(),
    ).toEqual({
      admission_outcome: "accepted",
      job_id: 17,
      matrix_json: '{"x":1}',
    });
    expect(
      database()
        .prepare("SELECT COUNT(*) AS count FROM schema_migrations WHERE version = ?")
        .get("036_workflow_run_admission_outcomes"),
    ).toEqual({ count: 1 });
  });
});
