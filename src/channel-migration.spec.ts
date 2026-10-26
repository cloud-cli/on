import { beforeEach, describe, expect, it, vi } from "vitest";

const database = vi.hoisted(() => ({ all: vi.fn(), run: vi.fn(), exec: vi.fn() }));
vi.mock("./db-client.js", () => ({ default: database }));
import { runMigrations } from "./migrations.js";

describe("durable channel migration", () => {
  beforeEach(() => {
    vi.resetAllMocks();
    const versions = [
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
      "029_step_attempt_identity",
      "030_domain_event_delivery_invocation_link",
      "032_step_attempt_snapshots",
    ];
    database.all.mockImplementation(async (sql: string) =>
      sql.includes("SELECT version FROM schema_migrations") ? versions.map((version) => ({ version })) : [],
    );
  });

  it("adds workspace-scoped channels and immutable messages with causal reference fields", async () => {
    await runMigrations();
    const migration = database.exec.mock.calls.find(([sql]: [string]) =>
      sql.includes("CREATE TABLE IF NOT EXISTS channel_messages"),
    )?.[0];
    expect(migration).toContain("PRIMARY KEY (team_id, id)");
    expect(migration).toContain("FOREIGN KEY (team_id, channel_id) REFERENCES channels(team_id, id)");
    expect(migration).toContain("body_json TEXT NOT NULL CHECK (json_valid(body_json))");
    expect(migration).toContain("caused_by_event_id TEXT");
    expect(migration).toContain("caused_by_job_id INTEGER");
    expect(migration).toContain("BEFORE UPDATE ON channel_messages");
    expect(migration).not.toContain("BEFORE DELETE ON channel_messages");
    expect(database.run).toHaveBeenCalledWith("INSERT INTO schema_migrations (version) VALUES (?)", [
      "019_durable_channel_history",
    ]);
  });

  it("can safely retry migration DDL", async () => {
    await runMigrations();
    const ddl = database.exec.mock.calls.find(([sql]: [string]) =>
      sql.includes("CREATE TABLE IF NOT EXISTS channels"),
    )?.[0];
    expect(ddl).toContain("CREATE TRIGGER IF NOT EXISTS");
    expect(ddl.match(/CREATE TABLE IF NOT EXISTS/g)).toHaveLength(2);
  });
});
