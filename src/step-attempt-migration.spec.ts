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

describe("durable step-attempt migration", () => {
  it("adds immutable attempt identity and safe cascades", async () => {
    await runMigrations();
    const db = (await import("./db-client.js")).default as any;
    const migration = db.exec.mock.calls
      .map(([sql]: [string]) => sql)
      .find((sql: string) => sql.includes("step_execution_attempts"));
    expect(migration).toContain("UNIQUE(job_id, step_id, attempt)");
    expect(migration).toContain("REFERENCES teams(id) ON DELETE CASCADE");
    expect(migration).toContain("REFERENCES jobs(id) ON DELETE CASCADE");
    expect(migration).toContain("log_content TEXT NOT NULL DEFAULT ''");
  });
});
