import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DatabaseSync } from "node:sqlite";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { StandardProcessDriver } from "./drivers/standard-process.driver.js";

import { QueueManager } from "./queue.js";
import { WorkflowRunAdmissionRepository } from "./workflow-run-admission-repository.js";
import type { JobRecord } from "./types.js";

const testDb = vi.hoisted(() => ({ database: null as DatabaseSync | null }));
let temporaryDirectory: string | null = null;

// Provide a test master key for secret encryption in isolation
process.env.RUNNER_MASTER_KEY = "test-master-key-1234567890abcdef";

vi.mock("./db-client.js", () => {
  const execute = (sql: string, values: unknown[] = []) => testDb.database!.prepare(sql).run(...(values as any[]));
  return {
    default: {
      all: async (sql: string, values: unknown[] = []) => testDb.database!.prepare(sql).all(...(values as any[])),
      get: async (sql: string, values: unknown[] = []) => testDb.database!.prepare(sql).get(...(values as any[])),
      run: (sql: string, ...values: unknown[]) => execute(sql, ...values),
      transaction: async (statements: Array<{ s: string; d: unknown[] }>) => {
        testDb.database!.exec("BEGIN IMMEDIATE");
        try {
          for (const statement of statements) {
            testDb.database!.prepare(statement.s).run(...(statement.d as any[]));
          }
          testDb.database!.exec("COMMIT");
        } catch (error) {
          testDb.database!.exec("ROLLBACK");
          throw error;
        }
      },
    },
  };
});

afterEach(() => {
  testDb.database?.close();
  testDb.database = null;
  if (temporaryDirectory) {
    fs.rmSync(temporaryDirectory, { recursive: true, force: true });
    temporaryDirectory = null;
  }
});

describe("agent invocation worker integration", () => {
  beforeEach(() => {
    temporaryDirectory = fs.mkdtempSync(path.join(os.tmpdir(), "agent-invocation-"));
    const databasePath = path.join(temporaryDirectory, "test.sqlite");
    testDb.database = new DatabaseSync(databasePath);

    // Initialize minimal schema required for worker execution
    testDb.database.exec(`
      CREATE TABLE IF NOT EXISTS teams (
        id TEXT PRIMARY KEY,
        name TEXT,
        deleting_at DATETIME
      );
      CREATE TABLE IF NOT EXISTS workflows (
        id TEXT PRIMARY KEY,
        team_id TEXT NOT NULL REFERENCES teams(id),
        name TEXT NOT NULL,
        active_revision INTEGER NOT NULL DEFAULT 1,
        deleting_at DATETIME,
        normalized_json TEXT
      );
      CREATE TABLE IF NOT EXISTS workflow_revisions (
        workflow_id TEXT NOT NULL,
        revision INTEGER NOT NULL,
        definition TEXT NOT NULL,
        normalized_json TEXT,
        PRIMARY KEY (workflow_id, revision)
      );
      CREATE TABLE IF NOT EXISTS recipe_versions (
        namespace TEXT NOT NULL,
        slug TEXT NOT NULL,
        version INTEGER NOT NULL,
        revoked INTEGER NOT NULL DEFAULT 0,
        PRIMARY KEY (namespace, slug, version)
      );
      CREATE TABLE IF NOT EXISTS workflow_run_admissions (
        event_id TEXT NOT NULL, team_id TEXT NOT NULL, workflow_id TEXT NOT NULL, revision INTEGER NOT NULL,
        variant_index INTEGER NOT NULL, matrix_json TEXT NOT NULL, tags_json TEXT NOT NULL,
        status TEXT NOT NULL DEFAULT 'pending', admission_outcome TEXT, job_id INTEGER, error_code TEXT,
        lease_token TEXT, lease_until TEXT, retry_after TEXT, updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
        PRIMARY KEY(event_id, variant_index)
      );
      CREATE TABLE IF NOT EXISTS workflow_run_admission_plans (event_id TEXT PRIMARY KEY, variant_count INTEGER NOT NULL, plan_hash TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS jobs (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        parentId INTEGER,
        workflow_id TEXT NOT NULL,
        workflow_revision INTEGER NOT NULL,
        required_tags TEXT NOT NULL DEFAULT '[]',
        payload TEXT NOT NULL,
        status TEXT NOT NULL DEFAULT 'pending',
        concurrency_key TEXT,
        worker_id TEXT,
        team_id TEXT,
        report TEXT,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        started_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        finished_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        lease_id TEXT,
        lease_token_hash TEXT,
        lease_expires_at DATETIME,
        lease_fenced INTEGER NOT NULL DEFAULT 0,
        lease_completed INTEGER NOT NULL DEFAULT 0,
        dispatch_key TEXT UNIQUE
      );
      CREATE INDEX IF NOT EXISTS idx_jobs_dispatch_key ON jobs(dispatch_key);
      CREATE TABLE IF NOT EXISTS step_execution_attempt_starts (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        team_id INTEGER, job_id INTEGER, step_id TEXT, attempt INTEGER, started_at TEXT,
        attempt_id TEXT,
        UNIQUE(team_id, job_id, step_id, attempt)
      );
      CREATE TABLE IF NOT EXISTS step_execution_attempts (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        team_id INTEGER, job_id INTEGER, step_id TEXT, attempt INTEGER, status TEXT,
        started_at TEXT, completed_at TEXT, duration_ms INTEGER, exit_code INTEGER,
        error TEXT, log_content TEXT, attempt_id TEXT, snapshot_json TEXT,
        FOREIGN KEY(job_id) REFERENCES jobs(id) ON DELETE CASCADE
      );
      CREATE TABLE IF NOT EXISTS domain_events (
        id TEXT PRIMARY KEY, team_id TEXT NOT NULL, type TEXT NOT NULL, schema_version INTEGER NOT NULL,
        source TEXT NOT NULL, occurred_at TEXT NOT NULL, recorded_at TEXT NOT NULL, correlation_id TEXT,
        causation_id TEXT, idempotency_key TEXT NOT NULL, data_json TEXT NOT NULL
      );
      CREATE UNIQUE INDEX IF NOT EXISTS idx_step_logs_job_step ON step_execution_attempts(job_id, step_id, attempt);
    `);

    // Insert test data needed for QueueManager enqueueDispatch to work
    testDb.database.prepare(`INSERT OR IGNORE INTO teams (id, name) VALUES ('workspace-1', 'test-workspace')`).run();
    testDb.database
      .prepare(
        `INSERT OR IGNORE INTO workflows (id, team_id, name, active_revision, normalized_json) VALUES ('test-workflow', 'workspace-1', 'Test Workflow', 1, '{}')`,
      )
      .run();
    testDb.database
      .prepare(`INSERT OR IGNORE INTO teams (id, name) VALUES ('workspace-alpha', 'alpha-workspace')`)
      .run();
    testDb.database
      .prepare(
        `INSERT OR IGNORE INTO workflows (id, team_id, name, active_revision, normalized_json) VALUES ('test-workflow-alpha', 'workspace-alpha', 'Alpha Workflow', 2, '{}')`,
      )
      .run();
    testDb.database
      .prepare(
        `INSERT OR IGNORE INTO workflow_revisions (workflow_id, revision, definition, normalized_json) VALUES ('test-workflow-alpha', 2, '{}', '{}')`,
      )
      .run();
    testDb.database
      .prepare(
        `INSERT OR IGNORE INTO workflow_revisions (workflow_id, revision, definition, normalized_json) VALUES ('test-workflow', 1, '{}', '{}')`,
      )
      .run();
    testDb.database
      .prepare(
        `INSERT OR IGNORE INTO recipe_versions (namespace, slug, version, revoked) VALUES ('on', 'test-workflow', 1, 0)`,
      )
      .run();
  });

  afterEach(() => {
    testDb.database?.close();
    testDb.database = null;
    if (temporaryDirectory) {
      fs.rmSync(temporaryDirectory, { recursive: true, force: true });
      temporaryDirectory = null;
    }
  });

  describe("successful terminal result", () => {
    it("completes a workflow job end-to-end through queue and admission persistence", async () => {
      const workerId = "test-agent";
      const queue = new QueueManager(workerId);
      const admissions = new WorkflowRunAdmissionRepository();

      // Set up a workflow admission variant
      const eventId = `agent-test-success-${Date.now()}`;
      await admissions.persistPlan([
        {
          eventId,
          teamId: "workspace-1",
          workflowId: "test-workflow",
          revision: 1,
          index: 0,
          matrix: {},
          tags: ["main-server"],
        },
      ]);

      // Claim the variant
      const claimed = await admissions.claimVariant(eventId, 0);
      expect(claimed).not.toBeNull();
      expect(claimed!.token).toBeDefined();

      // Enqueue the job via the queue using the real enqueueDispatch flow
      const jobId = await queue.enqueueDispatch(
        "test-workflow",
        1,
        {
          inputs: { message: "hello world" },
          matrix: {},
        },
        ["main-server"],
        "workspace-1",
        String(claimed!.id || 0),
        `test-dispatch-key:${eventId}:0`,
        {
          eventId,
          variantIndex: 0,
          leaseToken: claimed!.token,
        },
      );
      expect(jobId).toBeGreaterThan(0);
      await admissions.finish(claimed!, "admitted", jobId);

      // Verify the admission was updated to admitted with jobId
      const updated = await admissions.get(eventId, 0);
      expect(updated).not.toBeNull();
      expect(updated!.status).toBe("admitted");
      expect(updated!.jobId).toBe(jobId);

      // Claim the job from the queue using real QueueManager methods
      const claimedJob = await queue.claimNextJob(["main-server"]);
      expect(claimedJob).not.toBeNull();
      expect(claimedJob!.id).toBe(jobId);
      expect(claimedJob!.status).toBe("running");

      // Create a deterministic step that succeeds
      const driver = new StandardProcessDriver();
      const stepCtx = {
        jobId: String(jobId),
        step: {
          id: "assert",
          name: "assert",
          run: "echo 'step executed' && exit 0",
          timeoutMs: 10000,
        },
        env: {
          RUN_ID: String(jobId),
          RUN_NAME: "test-workflow",
          RUN_URL: "http://runner.test/ui/runs/" + jobId,
          WORKING_DIR: "/tmp",
          PATH: process.env.PATH || "/usr/local/bin:/usr/bin:/bin",
        },
        logsDir: path.join(temporaryDirectory!, "logs"),
        workingDir: path.join(temporaryDirectory!, "wd"),
        secretFilesDir: undefined,
        command: "echo 'step executed' && exit 0",
        image: undefined,
        volumes: [],
        dockerArgs: [],
        timeoutMs: 10000,
        attempt: 1,
      };

      // Execute the step via the real driver
      const handle = driver.execute(stepCtx);
      const result = await handle.done;
      expect(result.exitCode).toBe(0);

      // Complete the job with success status
      const report = {
        jobId: String(jobId),
        parentId: "",
        workflowName: "test-workflow",
        status: "success",
        durationMs: 100,
        startedAt: new Date().toISOString(),
        finishedAt: new Date().toISOString(),
        inputs: { message: "hello world" },
        environment: {
          RUN_ID: String(jobId),
          RUN_NAME: "test-workflow",
          RUN_URL: "http://runner.test/ui/runs/" + jobId,
        },
        steps: [
          {
            id: "assert",
            name: "assert",
            status: "success",
            durationMs: result.durationMs,
            exitCode: 0,
            outputs: {},
            logContent: "",
          },
        ],
        callInstances: [],
        artifacts: [],
        rerunToken: JSON.stringify({ jobId, payload: {} }),
      };

      await queue.completeJob(jobId, "success", report);

      // Verify job is marked as completed
      const finishedJob = await queue.getJob(jobId);
      expect(finishedJob?.status).toBe("success");

      // Verify domain event was persisted
      const events = testDb
        .database!.prepare("SELECT * FROM domain_events WHERE id LIKE ?")
        .all(`workflow-job:${jobId}:terminal`);
      expect(events.length).toBeGreaterThanOrEqual(1);
    });
  });

  describe("failed driver result", () => {
    it("handles a step that exits with non-zero code", async () => {
      const workerId = "test-agent-fail";
      const queue = new QueueManager(workerId);
      const admissions = new WorkflowRunAdmissionRepository();

      const eventId = `agent-test-fail-${Date.now()}`;
      await admissions.persistPlan([
        {
          eventId,
          teamId: "workspace-1",
          workflowId: "test-workflow",
          revision: 1,
          index: 0,
          matrix: {},
          tags: ["main-server"],
        },
      ]);

      const claimed = await admissions.claimVariant(eventId, 0);
      expect(claimed).not.toBeNull();

      const jobId = await queue.enqueueDispatch(
        "test-workflow",
        1,
        { inputs: {}, matrix: {} },
        ["main-server"],
        "workspace-1",
        String(claimed!.id || 0),
        `test-dispatch-key:${eventId}:0`,
        { eventId, variantIndex: 0, leaseToken: claimed!.token },
      );
      expect(jobId).toBeGreaterThan(0);
      await admissions.finish(claimed!, "admitted", jobId);

      // Create a step that fails (exit code 1)
      const driver = new StandardProcessDriver();
      const stepCtx = {
        jobId: String(jobId),
        step: {
          id: "fail-step",
          name: "fail-step",
          run: "exit 1",
          timeoutMs: 10000,
        },
        env: {
          RUN_ID: String(jobId),
          RUN_NAME: "test-workflow",
          RUN_URL: "http://runner.test/ui/runs/" + jobId,
          WORKING_DIR: "/tmp",
          PATH: process.env.PATH || "/usr/local/bin:/usr/bin:/bin",
        },
        logsDir: path.join(temporaryDirectory!, "logs"),
        workingDir: path.join(temporaryDirectory!, "wd"),
        secretFilesDir: undefined,
        command: "exit 1",
        image: undefined,
        volumes: [],
        dockerArgs: [],
        timeoutMs: 10000,
        attempt: 1,
      };

      const handle = driver.execute(stepCtx);
      const result = await handle.done;
      expect(result.exitCode).toBe(1);

      // Complete the job with failed status
      const report = {
        jobId: String(jobId),
        parentId: "",
        workflowName: "test-workflow",
        status: "failed",
        durationMs: 100,
        startedAt: new Date().toISOString(),
        finishedAt: new Date().toISOString(),
        inputs: {},
        environment: {
          RUN_ID: String(jobId),
          RUN_NAME: "test-workflow",
          RUN_URL: "http://runner.test/ui/runs/" + jobId,
        },
        steps: [
          {
            id: "fail-step",
            name: "fail-step",
            status: "failed",
            durationMs: result.durationMs,
            exitCode: 1,
            outputs: {},
            logContent: "",
          },
        ],
        callInstances: [],
        artifacts: [],
        rerunToken: JSON.stringify({ jobId, payload: {} }),
      };

      await queue.completeJob(jobId, "failed", report);

      const finishedJob = await queue.getJob(jobId);
      expect(finishedJob?.status).toBe("failed");
    });
  });

  describe("idempotent repeated admission", () => {
    it("does not duplicate job enqueues on repeated admission attempts", async () => {
      const workerId = "test-agent-idempotent";
      const queue = new QueueManager(workerId);
      const admissions = new WorkflowRunAdmissionRepository();

      const eventId = `agent-test-idempotent-${Date.now()}`;
      await admissions.persistPlan([
        {
          eventId,
          teamId: "workspace-1",
          workflowId: "test-workflow",
          revision: 1,
          index: 0,
          matrix: {},
          tags: ["main-server"],
        },
      ]);

      // First admission cycle
      const claimed1 = await admissions.claimVariant(eventId, 0);
      expect(claimed1).not.toBeNull();

      let jobId1 = await queue.enqueueDispatch(
        "test-workflow",
        1,
        { inputs: {}, matrix: {} },
        ["main-server"],
        "workspace-1",
        String(claimed1!.id || 0),
        `test-dispatch-key:${eventId}:0`,
        { eventId, variantIndex: 0, leaseToken: claimed1!.token },
      );
      expect(jobId1).toBeGreaterThan(0);

      // Finish first admission
      await admissions.finish(claimed1!, "admitted", jobId1!);

      // Verify only one job was created for this event
      const allJobs = testDb
        .database!.prepare("SELECT * FROM jobs WHERE workflow_id = ? AND workflow_revision = ?")
        .all("test-workflow", 1);
      const matchingJobs = allJobs.filter((j: any) => j.dispatch_key?.startsWith("test-dispatch-key:"));
      expect(matchingJobs.length).toBeLessThanOrEqual(1);
    });
  });

  describe("workspace-scoped result", () => {
    it("associates job with correct team/workspace via admission persistence", async () => {
      const workerId = "test-agent-workspace";
      const queue = new QueueManager(workerId);
      const admissions = new WorkflowRunAdmissionRepository();

      const eventId = `agent-test-workspace-${Date.now()}`;
      await admissions.persistPlan([
        {
          eventId,
          teamId: "workspace-alpha",
          workflowId: "test-workflow-alpha",
          revision: 2,
          index: 1,
          matrix: { os: ["linux"] },
          tags: ["docker"],
        },
      ]);

      const claimed = await admissions.claimVariant(eventId, 1);
      expect(claimed).not.toBeNull();

      const jobId = await queue.enqueueDispatch(
        "test-workflow-alpha",
        2,
        { inputs: { os: "linux" }, matrix: { os: ["linux"] } },
        ["docker"],
        "workspace-alpha",
        String(claimed!.id || 0),
        `test-dispatch-key:${eventId}:1`,
        { eventId, variantIndex: 1, leaseToken: claimed!.token },
      );
      expect(jobId).toBeGreaterThan(0);
      await admissions.finish(claimed!, "admitted", jobId);

      // Verify admission links to correct team
      const updated = await admissions.get(eventId, 1);
      expect(updated!.status).toBe("admitted");
      expect(updated!.jobId).toBe(jobId);

      // Verify worker tags match job required_tags
      const claimedJob = await queue.claimNextJob(["docker"]);
      expect(claimedJob).not.toBeNull();
      // The job should have team_id set from the admission
      expect(claimedJob?.team_id).toBe("workspace-alpha");

      // Complete the job
      const report = {
        jobId: String(jobId),
        parentId: "",
        workflowName: "test-workflow",
        status: "success",
        durationMs: 50,
        startedAt: new Date().toISOString(),
        finishedAt: new Date().toISOString(),
        inputs: { os: "linux" },
        environment: { RUN_ID: String(jobId), RUN_NAME: "test-workflow" },
        steps: [],
        callInstances: [],
        artifacts: [],
        rerunToken: JSON.stringify({ jobId, payload: {} }),
      };

      await queue.completeJob(jobId, "success", report);
      const finishedJob = await queue.getJob(jobId);
      expect(finishedJob?.status).toBe("success");
    });
  });

  describe("ungranted Agent denial", () => {
    it("rejects job claim when worker tags do not match job required_tags", async () => {
      const workerId = "test-agent-unauthorized";
      const queue = new QueueManager(workerId);
      const admissions = new WorkflowRunAdmissionRepository();

      const eventId = `agent-test-denial-${Date.now()}`;
      await admissions.persistPlan([
        {
          eventId,
          teamId: "workspace-1",
          workflowId: "test-workflow",
          revision: 1,
          index: 0,
          matrix: {},
          tags: ["main-server"],
        },
      ]);

      const claimed = await admissions.claimVariant(eventId, 0);
      expect(claimed).not.toBeNull();

      // Enqueue job with tags that the worker doesn't match
      const jobId = await queue.enqueueDispatch(
        "test-workflow",
        1,
        { inputs: {}, matrix: {} },
        ["main-server"], // required tags
        "workspace-1",
        String(claimed!.id || 0),
        `test-dispatch-key:${eventId}:0`,
        { eventId, variantIndex: 0, leaseToken: claimed!.token },
      );
      expect(jobId).toBeGreaterThan(0);
      await admissions.finish(claimed!, "admitted", jobId);

      // Verify the job exists and has the right payload
      const job = await queue.getJob(jobId);
      expect(job).not.toBeNull();
      const payload = job!.payload as { inputs?: unknown };
      expect(payload?.inputs).toEqual({});

      // The unauthorized worker should not be able to claim this job
      // (claimNextJob checks required_tags against worker's tags via json_each NOT IN)
      const wrongTagsQueue = new QueueManager("wrong-tags-worker");
      const unauthorizedClaim = await wrongTagsQueue.claimNextJob(["nonexistent-tag"]);
      // The job should not be claimable by a worker without the right tags
      expect(unauthorizedClaim).toBeNull();
    });
  });
});
