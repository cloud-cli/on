import { beforeEach, describe, expect, it, vi } from "vitest";
import { runMigrations } from "./migrations.js";

vi.mock("./db-client.js", () => {
  const initialVersions = [
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
    "029_step_attempt_identity",
    "030_domain_event_delivery_invocation_link",
    "032_step_attempt_snapshots",
    "033_stream_event_bindings",
    "034_stream_event_binding_integrity",
  ];
  const state = {
    versions: new Set(initialVersions),
    retryAfterExists: false,
    failMarkerInsert: false,
    failRetryIndex: false,
  };
  const reset = (
    options: {
      retryAfterExists?: boolean;
      version023?: boolean;
      failMarkerInsert?: boolean;
      failRetryIndex?: boolean;
    } = {},
  ) => {
    state.versions = new Set(initialVersions);
    if (options.version023) {
      state.versions.add("023_workflow_run_admission_retry_schedule");
    }
    state.retryAfterExists = options.retryAfterExists ?? false;
    state.failMarkerInsert = options.failMarkerInsert ?? false;
    state.failRetryIndex = options.failRetryIndex ?? false;
    database.all.mockClear();
    database.run.mockClear();
    database.exec.mockClear();
  };
  const database = {
    all: vi.fn(async (sql: string) => {
      if (sql.includes("SELECT version FROM schema_migrations")) {
        return [...state.versions].map((version) => ({ version }));
      }
      if (sql.includes("PRAGMA table_info(workflow_run_admissions)")) {
        return state.retryAfterExists ? [{ name: "retry_after" }] : [];
      }
      return [];
    }),
    run: vi.fn(async (sql: string, values?: string[]) => {
      if (sql.includes("ALTER TABLE workflow_run_admissions ADD COLUMN retry_after")) {
        state.retryAfterExists = true;
      }
      if (sql.includes("INSERT INTO schema_migrations")) {
        if (values![0] === "023_workflow_run_admission_retry_schedule" && state.failMarkerInsert) {
          state.failMarkerInsert = false;
          throw new Error("simulated marker write failure");
        }
        state.versions.add(values![0]);
      }
      return {};
    }),
    exec: vi.fn(async (sql: string) => {
      if (sql.includes("CREATE INDEX IF NOT EXISTS workflow_run_admissions_retry") && state.failRetryIndex) {
        state.failRetryIndex = false;
        throw new Error("simulated retry index failure");
      }
    }),
  };
  return { default: database, __test: { reset } };
});

const dbModule = await import("./db-client.js");
const db = dbModule.default as any;
const resetDatabase = (dbModule as any).__test.reset as (options?: {
  retryAfterExists?: boolean;
  version023?: boolean;
  failMarkerInsert?: boolean;
  failRetryIndex?: boolean;
}) => void;

describe("durable workflow-run admission retry migration", () => {
  beforeEach(() => resetDatabase());

  it("retries after the column exists but the migration marker write failed", async () => {
    resetDatabase({ failMarkerInsert: true });
    await expect(runMigrations()).rejects.toThrow("simulated marker write failure");
    await expect(runMigrations()).resolves.toBeUndefined();
    expect(
      db.run.mock.calls.filter(([sql]: [string]) =>
        sql.includes("ALTER TABLE workflow_run_admissions ADD COLUMN retry_after"),
      ),
    ).toHaveLength(1);
    expect(
      db.exec.mock.calls.filter(([sql]: [string]) =>
        sql.includes("CREATE INDEX IF NOT EXISTS workflow_run_admissions_retry"),
      ),
    ).toHaveLength(2);
  });

  it("repairs a pre-existing column whose index and version marker are missing", async () => {
    resetDatabase({ retryAfterExists: true });
    await expect(runMigrations()).resolves.toBeUndefined();
    expect(db.run.mock.calls.some(([sql]: [string]) => sql.includes("ADD COLUMN retry_after"))).toBe(false);
    expect(db.exec).toHaveBeenCalledWith(
      expect.stringContaining("ON workflow_run_admissions(status, retry_after, updated_at, event_id, variant_index)"),
    );
  });

  it("retries after index creation fails without repeating the column alteration", async () => {
    resetDatabase({ failRetryIndex: true });
    await expect(runMigrations()).rejects.toThrow("simulated retry index failure");
    await expect(runMigrations()).resolves.toBeUndefined();
    expect(
      db.run.mock.calls.filter(([sql]: [string]) =>
        sql.includes("ALTER TABLE workflow_run_admissions ADD COLUMN retry_after"),
      ),
    ).toHaveLength(1);
    expect(
      db.exec.mock.calls.filter(([sql]: [string]) =>
        sql.includes("CREATE INDEX IF NOT EXISTS workflow_run_admissions_retry"),
      ),
    ).toHaveLength(2);
  });

  it("skips the retry migration when its version marker is already present", async () => {
    resetDatabase({ retryAfterExists: true, version023: true });
    await expect(runMigrations()).resolves.toBeUndefined();
    expect(db.run.mock.calls.some(([sql]: [string]) => sql.includes("ADD COLUMN retry_after"))).toBe(false);
    expect(
      db.exec.mock.calls.some(([sql]: [string]) =>
        sql.includes("CREATE INDEX IF NOT EXISTS workflow_run_admissions_retry"),
      ),
    ).toBe(false);
  });
});
