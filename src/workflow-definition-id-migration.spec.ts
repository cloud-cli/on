import { beforeEach, describe, expect, it, vi } from "vitest";

const database = vi.hoisted(() => ({ all: vi.fn(), get: vi.fn(), run: vi.fn(), exec: vi.fn(), transaction: vi.fn() }));
vi.mock("./db-client.js", () => ({ default: database }));

import { runMigrations } from "./migrations.js";

const applied = [
  "001_add_workflow_enabled",
  "002_add_push_subscriptions",
  "003_add_push_delivery_history",
  "004_add_ai_requests",
  "005_add_teams",
  "006_scope_push_subscriptions_to_teams",
  "007_scope_api_keys_to_teams",
  "008_workflows_team_foreign_key",
];

const workflowRow = (id: string, definitionId: string | null = null) => ({
  id,
  team_id: "team-a",
  definition_id: definitionId,
  source_yaml: "name: Build\non: { generic: {} }\nsteps: [{ run: 'true' }]\n",
});

const revisionRow = (workflowId: string, id: string) => ({
  workflow_id: workflowId,
  revision: 1,
  source_yaml: "name: Build\non: { generic: {} }\nsteps: [{ run: 'true' }]\n",
  normalized_json: JSON.stringify({ id, name: "Build", steps: [] }),
});

describe("workflow definition ID backfill migration", () => {
  beforeEach(() => {
    vi.resetAllMocks();
    database.transaction.mockResolvedValue([]);
    database.all.mockImplementation(async (sql: string) => {
      if (sql === "SELECT version FROM schema_migrations") {
        return applied.map((version) => ({ version }));
      }
      if (sql === "PRAGMA table_info(workflows)") {
        return ["id", "team_id", "source_yaml", "definition_id"].map((name) => ({ name }));
      }
      return [];
    });
  });

  it("backfills the editable ID into all stored YAML revisions and adds an atomic unique index", async () => {
    database.all.mockImplementation(async (sql: string) => {
      if (sql === "SELECT version FROM schema_migrations") {
        return applied.map((version) => ({ version }));
      }
      if (sql === "PRAGMA table_info(workflows)") {
        return ["id", "team_id", "source_yaml", "definition_id"].map((name) => ({ name }));
      }
      if (sql === "SELECT id, team_id, source_yaml, definition_id FROM workflows") {
        return [workflowRow("record-key")];
      }
      if (sql.startsWith("SELECT workflow_id, revision, source_yaml, normalized_json")) {
        return [revisionRow("record-key", "build-pipeline")];
      }
      return [];
    });

    await runMigrations();

    const statements = database.transaction.mock.calls[0][0];
    const revisionUpdate = statements.find((item: any) => item.s.startsWith("UPDATE workflow_revisions"));
    const workflowUpdate = statements.find((item: any) => item.s.startsWith("UPDATE workflows SET definition_id"));
    expect(revisionUpdate.d[0]).toMatch(/^id: "build-pipeline"\n/);
    expect(JSON.parse(revisionUpdate.d[1]).id).toBe("build-pipeline");
    expect(workflowUpdate.d).toEqual([
      "build-pipeline",
      expect.stringMatching(/^id: "build-pipeline"\n/),
      "record-key",
    ]);
    expect(
      statements.some((item: any) => item.s.includes("CREATE UNIQUE INDEX") && item.s.includes("definition_id")),
    ).toBe(true);
    expect(statements.some((item: any) => item.s.includes("CREATE TRIGGER") && item.s.includes("definition_id"))).toBe(
      true,
    );
  });

  it("refuses duplicate IDs within one workspace before any write", async () => {
    database.all.mockImplementation(async (sql: string) => {
      if (sql === "SELECT version FROM schema_migrations") {
        return applied.map((version) => ({ version }));
      }
      if (sql === "PRAGMA table_info(workflows)") {
        return ["id", "team_id", "source_yaml", "definition_id"].map((name) => ({ name }));
      }
      if (sql === "SELECT id, team_id, source_yaml, definition_id FROM workflows") {
        return [workflowRow("one"), workflowRow("two")];
      }
      if (sql.startsWith("SELECT workflow_id, revision, source_yaml, normalized_json")) {
        return [revisionRow("one", "duplicate"), revisionRow("two", "duplicate")];
      }
      return [];
    });

    await expect(runMigrations()).rejects.toThrow("duplicate ID in one workspace");
    expect(database.transaction).not.toHaveBeenCalled();
  });
});
