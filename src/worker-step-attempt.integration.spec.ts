import { afterEach, describe, expect, it, vi } from "vitest";
import { DatabaseSync } from "node:sqlite";
import FS from "node:fs";
import OS from "node:os";
import Path from "node:path";
import type { Processable } from "./types.js";
import { processJob } from "./worker.js";
import { QueueManager } from "./queue.js";
import { SecretStore } from "./secrets.js";
import { StandardProcessDriver } from "./drivers/standard-process.driver.js";

const testDb = vi.hoisted(() => ({ database: null as DatabaseSync | null }));
vi.mock("./db-client.js", () => ({
  default: {
    get: async (sql: string, values: unknown[] = []) => testDb.database!.prepare(sql).get(...(values as any[])),
    run: async (sql: string, values: unknown[] = []) => testDb.database!.prepare(sql).run(...(values as any[])),
    all: async (sql: string, values: unknown[] = []) => testDb.database!.prepare(sql).all(...(values as any[])),
    exec: async (sql: string) => testDb.database!.exec(sql),
    transaction: async (statements: Array<{ s: string; d?: unknown[] }>) => {
      testDb.database!.exec("BEGIN IMMEDIATE");
      try {
        for (const statement of statements) {
          testDb.database!.prepare(statement.s).run(...((statement.d || []) as any[]));
        }
        testDb.database!.exec("COMMIT");
      } catch (error) {
        testDb.database!.exec("ROLLBACK");
        throw error;
      }
    },
  },
}));

const databaseDir = FS.mkdtempSync(Path.join(OS.tmpdir(), "worker-attempt-"));

afterEach(() => {
  testDb.database?.close();
  testDb.database = null;
  FS.rmSync(databaseDir, { recursive: true, force: true });
});

describe("worker durable step attempt integration", () => {
  it("persists failed execution evidence and redacts secrets across database reopen", async () => {
    const databasePath = Path.join(databaseDir, "attempts.sqlite");
    testDb.database = new DatabaseSync(databasePath);
    testDb.database.exec(`
      CREATE TABLE teams (id TEXT PRIMARY KEY, deleting_at TEXT);
      CREATE TABLE jobs (
        id INTEGER PRIMARY KEY, team_id TEXT NOT NULL, workflow_id TEXT NOT NULL, workflow_revision INTEGER NOT NULL,
        status TEXT NOT NULL, payload TEXT, report TEXT, updated_at TEXT, finished_at TEXT,
        lease_id TEXT, lease_token_hash TEXT, lease_expires_at TEXT, lease_completed INTEGER DEFAULT 0
      );
      CREATE TABLE domain_events (
        id TEXT PRIMARY KEY, team_id TEXT NOT NULL, type TEXT NOT NULL, schema_version INTEGER NOT NULL,
        source TEXT NOT NULL, occurred_at TEXT NOT NULL, recorded_at TEXT NOT NULL, correlation_id TEXT,
        causation_id TEXT, idempotency_key TEXT NOT NULL, data_json TEXT NOT NULL
      );
      CREATE TABLE step_execution_attempt_starts (
        id INTEGER PRIMARY KEY, team_id TEXT NOT NULL, job_id INTEGER NOT NULL, step_id TEXT NOT NULL,
        attempt INTEGER NOT NULL, started_at TEXT NOT NULL, attempt_id TEXT NOT NULL,
        UNIQUE(job_id, step_id, attempt)
      );
      CREATE TABLE step_execution_attempts (
        id INTEGER PRIMARY KEY, team_id TEXT NOT NULL, job_id INTEGER NOT NULL, step_id TEXT NOT NULL,
        attempt INTEGER NOT NULL, status TEXT NOT NULL, started_at TEXT NOT NULL, completed_at TEXT NOT NULL,
        duration_ms INTEGER NOT NULL, exit_code INTEGER, error TEXT, log_content TEXT NOT NULL,
        attempt_id TEXT NOT NULL, snapshot_json TEXT, UNIQUE(job_id, step_id, attempt)
      );
      INSERT INTO teams VALUES ('team-1', NULL);
      INSERT INTO jobs (id, team_id, workflow_id, workflow_revision, status, payload)
        VALUES (501, 'team-1', 'failed-step', 1, 'running', '{"inputs":{"ordinary":"kept","writeOnly":"sensitive-value"}}');
    `);

    const queue = new QueueManager("integration-worker");
    queue.saveReport = async () => {};
    queue.saveStepLog = async () => {};
    queue.isCancelled = async () => false;
    const secrets = new SecretStore();
    secrets.replace({ API_TOKEN: "sensitive-value" });
    const previousShell = process.env.SHELL;
    process.env.SHELL = "/definitely-missing/sensitive-value-shell";
    try {
      await processJob({
        workerId: "integration-worker",
        job: {
          id: 501,
          workflow_id: "failed-step",
          workflow_revision: 1,
          required_tags: "[]",
          concurrency_key: null,
          status: "running",
          worker_id: "integration-worker",
          payload: JSON.stringify({ inputs: { ordinary: "kept", writeOnly: "sensitive-value" } }),
          created_at: new Date().toISOString(),
        },
        queue,
        secrets,
        config: { storagePath: databaseDir, serverUrl: "http://runner.test", env: {}, plugins: [] },
        driver: new StandardProcessDriver(),
        workflow: {
          id: "failed-step",
          name: "Failed step",
          on: {},
          steps: [{ id: "deploy", run: "false" }],
          _recipeInputSchema: { properties: { writeOnly: { type: "string", writeOnly: true } } },
        },
      } as Processable);
    } finally {
      if (previousShell === undefined) {
        delete process.env.SHELL;
      } else {
        process.env.SHELL = previousShell;
      }
    }

    const written = testDb.database.prepare("SELECT * FROM step_execution_attempts").get() as Record<string, unknown>;
    expect(written).toMatchObject({ job_id: 501, step_id: "deploy", attempt: 1, status: "failed", exit_code: 1 });
    expect(written.attempt_id).toMatch(/^[0-9a-f-]{36}$/i);
    expect(String(written.log_content)).not.toContain("sensitive-value");
    expect(written.error).toContain("****");
    expect(String(written.error)).not.toContain("sensitive-value");
    expect(testDb.database.prepare("SELECT status, report FROM jobs WHERE id = 501").get()).toMatchObject({
      status: "failed",
    });

    testDb.database.close();
    testDb.database = new DatabaseSync(databasePath);
    const persistedJob = testDb.database.prepare("SELECT status, report FROM jobs WHERE id = 501").get() as {
      status: string;
      report: string;
    };
    expect(persistedJob.status).toBe("failed");
    expect(JSON.parse(persistedJob.report).steps[0].error).toContain("****");
    expect(persistedJob.report).not.toContain("sensitive-value");
    const attempts = await queue.getStepAttemptsForTeam("team-1", 501);
    expect(attempts).toHaveLength(1);
    expect(attempts[0]).toMatchObject({
      job_id: 501,
      step_id: "deploy",
      attempt: 1,
      status: "failed",
      exit_code: 1,
      attempt_id: written.attempt_id,
      lifecycle_status: "completed",
    });
    expect(attempts[0].error).toContain("****");
    expect(attempts[0].error).not.toContain("sensitive-value");
    const snapshot = JSON.parse(attempts[0].snapshot_json);
    expect(snapshot.inputs).toEqual({ ordinary: "kept" });
    expect(JSON.stringify(snapshot)).not.toContain("sensitive-value");
  });
});
