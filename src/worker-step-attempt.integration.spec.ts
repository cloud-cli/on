import { afterEach, describe, expect, it, vi } from "vitest";
import { DatabaseSync } from "node:sqlite";
import FS from "node:fs";
import OS from "node:os";
import Path from "node:path";
import type { Processable } from "./types.js";
import { processJob } from "./worker.js";
import { QueueManager } from "./queue.js";
import { SecretStore } from "./secrets.js";

const testDb = vi.hoisted(() => ({ database: null as DatabaseSync | null }));
vi.mock("./db-client.js", () => ({
  default: {
    get: async (sql: string, values: unknown[] = []) => testDb.database!.prepare(sql).get(...(values as any[])),
    run: async (sql: string, values: unknown[] = []) => testDb.database!.prepare(sql).run(...(values as any[])),
    all: async (sql: string, values: unknown[] = []) => testDb.database!.prepare(sql).all(...(values as any[])),
    exec: async (sql: string) => testDb.database!.exec(sql),
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
      CREATE TABLE jobs (id INTEGER PRIMARY KEY, team_id TEXT NOT NULL);
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
      INSERT INTO jobs VALUES (501, 'team-1');
    `);

    const queue = new QueueManager("integration-worker");
    queue.saveReport = async () => {};
    queue.saveStepLog = async () => {};
    queue.completeJob = async () => {};
    queue.isCancelled = async () => false;
    const secrets = new SecretStore();
    secrets.replace({ API_TOKEN: "sensitive-value" });
    const logPath = Path.join(databaseDir, "step.log");
    FS.writeFileSync(logPath, "failed with sensitive-value");
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
      driver: {
        execute: () => ({ done: Promise.resolve({ exitCode: 23, durationMs: 4 }), cancel: () => {}, logFilePath: logPath }),
        readLog: async () => "failed with sensitive-value",
      },
      workflow: {
        id: "failed-step",
        name: "Failed step",
        on: {},
        steps: [{ id: "deploy", run: "false" }],
        _recipeInputSchema: { properties: { writeOnly: { type: "string", writeOnly: true } } },
      },
    } as Processable);

    const written = testDb.database.prepare("SELECT * FROM step_execution_attempts").get() as Record<string, unknown>;
    expect(written).toMatchObject({ job_id: 501, step_id: "deploy", attempt: 1, status: "failed", exit_code: 23 });
    expect(written.attempt_id).toMatch(/^[0-9a-f-]{36}$/i);
    expect(String(written.log_content)).toContain("****");
    expect(String(written.log_content)).not.toContain("sensitive-value");

    testDb.database.close();
    testDb.database = new DatabaseSync(databasePath);
    const attempts = await queue.getStepAttemptsForTeam("team-1", 501);
    expect(attempts).toHaveLength(1);
    expect(attempts[0]).toMatchObject({
      job_id: 501,
      step_id: "deploy",
      attempt: 1,
      status: "failed",
      exit_code: 23,
      attempt_id: written.attempt_id,
      lifecycle_status: "completed",
    });
    expect(attempts[0].log_content).toContain("****");
    const snapshot = JSON.parse(attempts[0].snapshot_json);
    expect(snapshot.inputs).toEqual({ ordinary: "kept" });
    expect(JSON.stringify(snapshot)).not.toContain("sensitive-value");
  });
});
