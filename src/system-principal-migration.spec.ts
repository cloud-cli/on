import { beforeEach, describe, expect, it, vi } from "vitest";

const database = vi.hoisted(() => ({ all: vi.fn(), run: vi.fn(), exec: vi.fn(), transaction: vi.fn() }));
vi.mock("./db-client.js", () => ({ default: database }));

import { runMigrations } from "./migrations.js";

describe("legacy system principal retirement migration", () => {
  beforeEach(() => {
    vi.resetAllMocks();
    database.transaction.mockResolvedValue([]);
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
          "029_step_attempt_identity",
          "030_domain_event_delivery_invocation_link",
          "032_step_attempt_snapshots",
          "033_stream_event_bindings",
        ].map((version) => ({ version }));
      }
      if (sql.includes("sqlite_master")) {
        return ["oidc_users", "principal_tokens", "team_members", "workspace_permission_overrides"].map((name) => ({
          name,
        }));
      }
      return [];
    });
  });

  it("atomically revokes tokens, removes memberships and overrides, and disables without deleting identities", async () => {
    await runMigrations();

    const statements = database.transaction.mock.calls[0][0].map(({ s }: { s: string }) => s);
    expect(statements).toHaveLength(4);
    expect(statements[0]).toContain("UPDATE principal_tokens SET revoked_at = COALESCE(revoked_at, CURRENT_TIMESTAMP)");
    expect(statements[0]).toContain("kind = 'system'");
    expect(statements[1]).toContain("DELETE FROM team_members");
    expect(statements[2]).toContain("DELETE FROM workspace_permission_overrides");
    expect(statements[3]).toContain("UPDATE oidc_users SET disabled_at = COALESCE(disabled_at, CURRENT_TIMESTAMP)");
    expect(statements.join("\n")).not.toContain("DELETE FROM oidc_users");
    expect(database.exec).toHaveBeenCalledWith(
      expect.stringContaining("CREATE TABLE IF NOT EXISTS team_subject_invitations"),
    );
  });
});
