import { beforeEach, describe, expect, it, vi } from "vitest";

const database = vi.hoisted(() => ({ all: vi.fn(), get: vi.fn(), run: vi.fn(), exec: vi.fn(), transaction: vi.fn() }));
vi.mock("./db-client.js", () => ({ default: database }));

import { runMigrations } from "./migrations.js";

describe("workflow team foreign-key migration", () => {
  beforeEach(() => {
    vi.resetAllMocks();
    database.transaction.mockResolvedValue([]);
    database.get.mockImplementation(async (sql: string) => {
      if (sql.includes("name = 'team_members'")) {
        return {
          sql: "CREATE TABLE team_members (team_id TEXT, subject TEXT, role TEXT CHECK(role IN ('viewer','collaborator','admin')), created_at DATETIME)",
        };
      }
      return {
        sql: "CREATE TABLE workflows (id TEXT PRIMARY KEY, name TEXT NOT NULL, source_yaml TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'draft', active_revision INTEGER, enabled INTEGER NOT NULL DEFAULT 1, created_at DATETIME, updated_at DATETIME, team_id TEXT NOT NULL DEFAULT 'default')",
      };
    });
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
          "009_workflow_definition_ids",
          "029_step_attempt_identity",
          "030_domain_event_delivery_invocation_link",
          "032_step_attempt_snapshots",
          "033_stream_event_bindings",
        ].map((version) => ({ version }));
      }
      if (sql === "PRAGMA table_info(workflows)") {
        return [
          "id",
          "name",
          "source_yaml",
          "status",
          "active_revision",
          "enabled",
          "created_at",
          "updated_at",
          "team_id",
        ].map((name) => ({ name }));
      }
      if (sql === "PRAGMA table_info(teams)") {
        return [{ name: "id" }, { name: "name" }];
      }
      if (
        sql === "PRAGMA table_info(team_members)" ||
        sql === "PRAGMA table_info(oidc_users)" ||
        sql === "PRAGMA table_info(api_keys)"
      ) {
        return [];
      }
      if (sql.includes("LEFT JOIN teams")) {
        return [];
      }
      if (sql.includes("type = 'index'")) {
        return [{ sql: "CREATE INDEX idx_workflows_team ON workflows(team_id, id)" }];
      }
      if (sql.includes("PRAGMA table_info(workflows_before_team_fk)")) {
        return [
          "id",
          "name",
          "source_yaml",
          "status",
          "active_revision",
          "enabled",
          "created_at",
          "updated_at",
          "team_id",
        ].map((name) => ({ name }));
      }
      return [];
    });
  });

  it("rebuilds the legacy table with ownership FK and copies every column and index", async () => {
    await runMigrations();
    const statements = database.transaction.mock.calls[0][0].map(({ s }: { s: string }) => s).join("\n");
    expect(statements).toContain("FOREIGN KEY (team_id) REFERENCES teams(id) ON DELETE RESTRICT");
    expect(statements).toContain("CREATE TABLE workflows_after_team_fk");
    expect(statements).toContain(
      'INSERT INTO workflows_after_team_fk ("id", "name", "source_yaml", "status", "active_revision", "enabled", "created_at", "updated_at", "team_id") SELECT',
    );
    expect(statements).toContain("DROP TABLE workflows");
    expect(statements).toContain("ALTER TABLE workflows_after_team_fk RENAME TO workflows");
    expect(statements).toContain("CREATE INDEX idx_workflows_team ON workflows(team_id, id)");
    expect(database.run).toHaveBeenCalledWith("INSERT INTO schema_migrations (version) VALUES (?)", [
      "008_workflows_team_foreign_key",
    ]);
  });

  it("does not provision an implicit default workspace or assign OIDC users", async () => {
    database.all.mockImplementation(async (sql: string) => {
      if (sql.includes("SELECT version FROM schema_migrations")) {
        return [
          "029_step_attempt_identity",
          "030_domain_event_delivery_invocation_link",
          "032_step_attempt_snapshots",
          "033_stream_event_bindings",
        ].map((version) => ({
          version,
        }));
      }
      if (sql === "PRAGMA table_info(workflows)") {
        return ["id", "name", "source_yaml", "status", "active_revision", "enabled", "team_id"].map((name) => ({
          name,
        }));
      }
      if (sql === "PRAGMA table_info(api_keys)") {
        return [];
      }
      if (sql === "PRAGMA table_info(teams)") {
        return [{ name: "id" }, { name: "name" }];
      }
      return [];
    });
    database.get.mockImplementation(async (sql: string) => {
      if (sql.includes("name = 'team_members'")) {
        return {
          sql: "CREATE TABLE team_members (team_id TEXT, subject TEXT, role TEXT CHECK(role IN ('viewer','collaborator','admin')), created_at DATETIME)",
        };
      }
      if (sql.includes("sqlite_master") && sql.includes("name = 'workflows'")) {
        return {
          sql: "CREATE TABLE workflows (id TEXT PRIMARY KEY, team_id TEXT NOT NULL REFERENCES teams(id) ON DELETE RESTRICT)",
        };
      }
      return null;
    });

    await runMigrations();
    const migrationSql = database.exec.mock.calls.map(([sql]: [string]) => sql).join("\n");
    expect(migrationSql).not.toMatch(/INSERT\s+OR\s+IGNORE\s+INTO\s+teams/i);
    expect(migrationSql).not.toMatch(/SELECT\s+'default',\s*subject\s+FROM\s+oidc_users/i);
  });

  it("keeps a fresh schema that already declares the workspace foreign key", async () => {
    database.get.mockImplementation(async (sql: string) => ({
      sql: sql.includes("name = 'team_members'")
        ? "CREATE TABLE team_members (team_id TEXT, subject TEXT, role TEXT CHECK(role IN ('viewer','collaborator','admin')), created_at DATETIME)"
        : "CREATE TABLE workflows (id TEXT, team_id TEXT, FOREIGN KEY (team_id) REFERENCES teams(id) ON DELETE RESTRICT)",
    }));

    await runMigrations();

    const migrationStatements = database.transaction.mock.calls.flatMap(([statements]) =>
      statements.map(({ s }: { s: string }) => s),
    );
    expect(migrationStatements).not.toEqual(
      expect.arrayContaining([expect.stringContaining("workflows_after_team_fk")]),
    );
    expect(database.run).toHaveBeenCalledWith("INSERT INTO schema_migrations (version) VALUES (?)", [
      "008_workflows_team_foreign_key",
    ]);
  });

  it("adds the workspace deletion fence atomically", async () => {
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
          "029_step_attempt_identity",
          "030_domain_event_delivery_invocation_link",
          "032_step_attempt_snapshots",
          "033_stream_event_bindings",
        ].map((version) => ({ version }));
      }
      if (sql === "PRAGMA table_info(teams)") {
        return [{ name: "id" }, { name: "name" }];
      }
      return [];
    });

    await runMigrations();

    expect(database.transaction).toHaveBeenCalledWith([
      { s: "ALTER TABLE teams ADD COLUMN deleting_at DATETIME", m: "run" },
    ]);
    expect(database.run).toHaveBeenCalledWith("INSERT INTO schema_migrations (version) VALUES (?)", [
      "011_workspace_deletion_fence",
    ]);
  });

  it("does not record the workspace deletion fence when the teams table is missing", async () => {
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
        ].map((version) => ({ version }));
      }
      return [];
    });

    await expect(runMigrations()).rejects.toThrow("teams table is missing");
    expect(database.run).not.toHaveBeenCalledWith("INSERT INTO schema_migrations (version) VALUES (?)", [
      "011_workspace_deletion_fence",
    ]);
  });

  it("refuses to migrate rather than silently reassigning an orphan owner", async () => {
    database.get.mockReset();
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
          "009_workflow_definition_ids",
          "029_step_attempt_identity",
          "030_domain_event_delivery_invocation_link",
          "032_step_attempt_snapshots",
          "033_stream_event_bindings",
        ].map((version) => ({ version }));
      }
      if (sql === "PRAGMA table_info(workflows)") {
        return [{ name: "team_id" }];
      }
      if (sql.includes("LEFT JOIN teams")) {
        return [{ id: "kept", team_id: "missing-team" }];
      }
      return [];
    });
    await expect(runMigrations()).rejects.toThrow(/workflow kept has missing team missing-team/);
    expect(database.transaction).not.toHaveBeenCalled();
    expect(database.run).not.toHaveBeenCalledWith("INSERT INTO schema_migrations (version) VALUES (?)", [
      "008_workflows_team_foreign_key",
    ]);
  });
});
