import { beforeEach, describe, expect, it, vi } from "vitest";

const database = vi.hoisted(() => ({
  all: vi.fn(),
  run: vi.fn(),
  exec: vi.fn(),
}));
vi.mock("./db-client.js", () => ({ default: database }));

import { runMigrations } from "./migrations.js";

describe("typed domain event migration", () => {
  beforeEach(() => {
    vi.resetAllMocks();
    database.all.mockImplementation(async (sql: string) => {
      if (sql.includes("SELECT version FROM schema_migrations")) {
        return [
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
          "029_step_attempt_identity",
          "030_domain_event_delivery_invocation_link",
        ].map((version) => ({ version }));
      }
      return [];
    });
  });

  it("adds durable team-scoped event storage and a non-null idempotency uniqueness index", async () => {
    await runMigrations();
    const migration = database.exec.mock.calls.find(([sql]: [string]) =>
      sql.includes("CREATE TABLE IF NOT EXISTS domain_events"),
    )?.[0];
    expect(migration).toContain("team_id TEXT NOT NULL REFERENCES teams(id)");
    expect(migration).toContain("schema_version INTEGER NOT NULL");
    expect(migration).toContain("data_json TEXT NOT NULL");
    expect(migration).toContain("ON domain_events(team_id, idempotency_key) WHERE idempotency_key IS NOT NULL");
    expect(migration).not.toContain("incoming_events");
  });

  it("adds a safe high-water boundary for future-only subscriptions", async () => {
    database.all.mockImplementation(async (sql: string) => {
      if (sql.includes("SELECT version FROM schema_migrations")) {
        return [
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
          "029_step_attempt_identity",
          "030_domain_event_delivery_invocation_link",
        ].map((version) => ({ version }));
      }
      return [];
    });
    await runMigrations();
    const migration = database.exec.mock.calls.find(([sql]: [string]) =>
      sql.includes("ADD COLUMN high_water_event_rowid"),
    )?.[0];
    expect(migration).toContain("INTEGER NOT NULL DEFAULT 0");
    expect(database.exec).toHaveBeenCalledWith(
      "CREATE INDEX IF NOT EXISTS idx_domain_events_rowid_team_type ON domain_events(team_id, type)",
    );
  });

  it("does not add the high-water column twice if a migration retry follows DDL", async () => {
    database.all.mockImplementation(async (sql: string) => {
      if (sql.includes("SELECT version FROM schema_migrations")) {
        return [
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
          "029_step_attempt_identity",
          "030_domain_event_delivery_invocation_link",
        ].map((version) => ({ version }));
      }
      if (sql === "PRAGMA table_info(domain_event_subscriptions)") {
        return [{ name: "high_water_event_rowid" }];
      }
      return [];
    });
    await runMigrations();
    expect(database.exec).not.toHaveBeenCalledWith(
      "ALTER TABLE domain_event_subscriptions ADD COLUMN high_water_event_rowid INTEGER NOT NULL DEFAULT 0",
    );
  });

  it("fails before creating the identity index if legacy duplicate subscriptions exist", async () => {
    database.all.mockImplementation(async (sql: string) => {
      if (sql.includes("SELECT version FROM schema_migrations")) {
        return [
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
          "029_step_attempt_identity",
          "030_domain_event_delivery_invocation_link",
        ].map((version) => ({ version }));
      }
      if (sql.includes("GROUP BY team_id, workflow_id, workflow_revision, event_type")) {
        return [{ team_id: "team-a", workflow_id: "build", workflow_revision: 1, event_type: "build" }];
      }
      return [];
    });
    await expect(runMigrations()).rejects.toThrow("1 duplicate identity group(s) exist");
    expect(database.exec).not.toHaveBeenCalledWith(expect.stringContaining("idx_domain_event_subscription_identity"));
  });
});
