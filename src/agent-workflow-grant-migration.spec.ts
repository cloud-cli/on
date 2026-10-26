import { describe, expect, it, vi } from "vitest";
import { runMigrations } from "./migrations.js";

vi.mock("./db-client.js", () => {
  const versions = new Set([
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
    "029_step_attempt_identity",
    "030_domain_event_delivery_invocation_link",
    "032_step_attempt_snapshots",
  ]);
  const database = {
    all: vi.fn(async (sql: string) =>
      sql.includes("SELECT version FROM schema_migrations") ? [...versions].map((version) => ({ version })) : [],
    ),
    run: vi.fn(async (sql: string, values?: string[]) => {
      if (sql.includes("INSERT INTO schema_migrations")) {
        versions.add(values![0]);
      }
      return {};
    }),
    exec: vi.fn(async () => {}),
  };
  return { default: database };
});

describe("agent workflow grant migration", () => {
  it("scopes unique grants to a workspace and cascades with workflow deletion", async () => {
    await runMigrations();
    const database = (await import("./db-client.js")).default as any;
    const grantMigration = database.exec.mock.calls
      .map(([sql]: [string]) => sql)
      .find((sql: string) => sql.includes("CREATE TABLE IF NOT EXISTS agent_workflow_grants"));

    expect(grantMigration).toContain("PRIMARY KEY (team_id, agent_principal_id, workflow_id)");
    expect(grantMigration).toContain(
      "FOREIGN KEY (team_id, agent_principal_id) REFERENCES team_members(team_id, subject) ON DELETE CASCADE",
    );
    expect(grantMigration).toContain(
      "FOREIGN KEY (team_id, workflow_id) REFERENCES workflows(team_id, id) ON DELETE CASCADE",
    );
    expect(grantMigration).toContain("granted_by TEXT NOT NULL");
    await runMigrations();
    const grantMigrations = database.exec.mock.calls.filter(([sql]: [string]) =>
      sql.includes("CREATE TABLE IF NOT EXISTS agent_workflow_grants"),
    );
    expect(grantMigrations).toHaveLength(1);
  });
});
