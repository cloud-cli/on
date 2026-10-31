import { afterEach, describe, expect, it, vi } from "vitest";
import { DatabaseSync } from "node:sqlite";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { QueueManager } from "./queue.js";
import { WorkflowRunAdmissionRepository } from "./workflow-run-admission-repository.js";
import { processJob } from "./worker.js";
import { StandardProcessDriver } from "./drivers/standard-process.driver.js";
import { SecretStore } from "./secrets.js";
import { AgentWorkflowGrantRepository } from "./agent-workflow-grant-repository.js";

const testDb = vi.hoisted(() => ({ database: null as DatabaseSync | null }));
let directory: string | undefined;
process.env.RUNNER_MASTER_KEY = "test-master-key-1234567890abcdef";

vi.mock("./db-client.js", () => ({
  default: {
    all: async (sql: string, values: unknown[] = []) => testDb.database!.prepare(sql).all(...(values as any[])),
    get: async (sql: string, values: unknown[] = []) => testDb.database!.prepare(sql).get(...(values as any[])),
    run: (sql: string, ...values: unknown[]) => {
      const parameters = values.length === 1 && Array.isArray(values[0]) ? values[0] : values;
      return testDb.database!.prepare(sql).run(...(parameters as any[]));
    },
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
}));

afterEach(() => {
  testDb.database?.close();
  testDb.database = null;
  if (directory) {
    fs.rmSync(directory, { recursive: true, force: true });
  }
  directory = undefined;
});

describe("authorized Agent workflow actual execution integration", () => {
  it("requires grant, executes the admitted run in a worker, and correlates its terminal result", async () => {
    directory = fs.mkdtempSync(path.join(os.tmpdir(), "agent-workflow-execution-"));
    testDb.database = new DatabaseSync(path.join(directory, "test.sqlite"));
    testDb.database.exec(`
      CREATE TABLE teams (id TEXT PRIMARY KEY, name TEXT, deleting_at TEXT);
      CREATE TABLE workflows (id TEXT PRIMARY KEY, team_id TEXT, name TEXT, active_revision INTEGER, deleting_at TEXT, normalized_json TEXT);
      CREATE TABLE workflow_revisions (workflow_id TEXT, revision INTEGER, definition TEXT, normalized_json TEXT, PRIMARY KEY(workflow_id, revision));
      CREATE TABLE recipe_versions (namespace TEXT, slug TEXT, version INTEGER, revoked INTEGER DEFAULT 0, PRIMARY KEY(namespace,slug,version));
      CREATE TABLE workflow_run_admissions (event_id TEXT NOT NULL, team_id TEXT NOT NULL, workflow_id TEXT NOT NULL, revision INTEGER NOT NULL,
        variant_index INTEGER NOT NULL, matrix_json TEXT NOT NULL, tags_json TEXT NOT NULL, status TEXT DEFAULT 'pending', admission_outcome TEXT,
        job_id INTEGER, error_code TEXT, lease_token TEXT, lease_until TEXT, retry_after TEXT, updated_at TEXT DEFAULT CURRENT_TIMESTAMP,
        PRIMARY KEY(event_id,variant_index));
      CREATE TABLE workflow_run_admission_plans (event_id TEXT PRIMARY KEY, variant_count INTEGER NOT NULL, plan_hash TEXT NOT NULL);
      CREATE TABLE jobs (id INTEGER PRIMARY KEY AUTOINCREMENT, parentId INTEGER, workflow_id TEXT NOT NULL, workflow_revision INTEGER NOT NULL,
        required_tags TEXT NOT NULL DEFAULT '[]', payload TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'pending', concurrency_key TEXT,
        worker_id TEXT, team_id TEXT, report TEXT, created_at TEXT DEFAULT CURRENT_TIMESTAMP, updated_at TEXT DEFAULT CURRENT_TIMESTAMP,
        started_at TEXT, finished_at TEXT, lease_id TEXT, lease_token_hash TEXT, lease_expires_at TEXT, lease_fenced INTEGER DEFAULT 0,
        lease_completed INTEGER DEFAULT 0, dispatch_key TEXT UNIQUE);
      CREATE TABLE step_execution_attempt_starts (id INTEGER PRIMARY KEY AUTOINCREMENT, team_id TEXT, job_id INTEGER, step_id TEXT, attempt INTEGER,
        started_at TEXT, attempt_id TEXT, UNIQUE(job_id,step_id,attempt));
      CREATE TABLE step_execution_attempts (id INTEGER PRIMARY KEY AUTOINCREMENT, team_id TEXT, job_id INTEGER, step_id TEXT, attempt INTEGER,
        status TEXT, started_at TEXT, completed_at TEXT, duration_ms INTEGER, exit_code INTEGER, error TEXT, log_content TEXT, attempt_id TEXT,
        snapshot_json TEXT, UNIQUE(job_id,step_id,attempt));
      CREATE TABLE domain_events (id TEXT PRIMARY KEY, team_id TEXT NOT NULL, type TEXT NOT NULL, schema_version INTEGER NOT NULL,
        source TEXT NOT NULL, occurred_at TEXT NOT NULL, recorded_at TEXT NOT NULL, correlation_id TEXT, causation_id TEXT,
        idempotency_key TEXT NOT NULL, data_json TEXT NOT NULL);
      CREATE TABLE agent_workflow_grants (
        team_id TEXT NOT NULL, agent_principal_id TEXT NOT NULL, workflow_id TEXT NOT NULL, granted_by TEXT NOT NULL,
        created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP, PRIMARY KEY(team_id, agent_principal_id, workflow_id));
      CREATE TABLE step_logs (
        id INTEGER PRIMARY KEY AUTOINCREMENT, job_id INTEGER NOT NULL, step_id TEXT NOT NULL, log_content TEXT NOT NULL,
        created_at TEXT DEFAULT CURRENT_TIMESTAMP, UNIQUE(job_id, step_id));
      CREATE INDEX idx_step_logs_job_step ON step_execution_attempts(job_id,step_id,attempt);
      INSERT INTO teams VALUES ('workspace-a','A',NULL),('workspace-b','B',NULL);
      INSERT INTO workflows VALUES ('wf','workspace-a','Agent test',1,NULL,'{}');
      INSERT INTO workflow_revisions VALUES ('wf',1,'{}','{}');
    `);

    const admission = new WorkflowRunAdmissionRepository();
    const queue = new QueueManager("worker-agent");
    const grants = new AgentWorkflowGrantRepository();
    await grants.grant("workspace-a", "agent-a", "wf", "human:admin");
    const admitRequest = async (workspace: string, agent: string, key: string) => {
      if (!(await grants.has(workspace, agent, "wf"))) {
        return { accepted: false as const };
      }
      const eventId = `request:${key}`;
      await admission.persistPlan([
        { eventId, teamId: workspace, workflowId: "wf", revision: 1, index: 0, matrix: {}, tags: [] },
      ]);
      const prior = await admission.get(eventId, 0);
      if (prior?.jobId) {
        return { accepted: true as const, eventId, jobId: prior.jobId };
      }
      const claim = await admission.claimVariant(eventId, 0);
      if (!claim) {
        return { accepted: true as const, eventId, jobId: (await admission.get(eventId, 0))?.jobId };
      }
      const jobId = await queue.enqueueDispatch(
        "wf",
        1,
        { inputs: { marker: "executed" }, matrix: {} },
        [],
        workspace,
        eventId,
        `workflow-run:${eventId}:0`,
        { eventId, variantIndex: 0, leaseToken: claim.token },
      );
      await admission.finish(claim, "admitted", jobId);
      return { accepted: true as const, eventId, jobId };
    };

    expect((await admitRequest("workspace-a", "agent-ungranted", "denied")).accepted).toBe(false);
    expect((await admitRequest("workspace-b", "agent-a", "cross-workspace")).accepted).toBe(false);
    const accepted = await admitRequest("workspace-a", "agent-a", "request-1");
    expect(accepted.accepted).toBe(true);
    const duplicate = await admitRequest("workspace-a", "agent-a", "request-1");
    expect(duplicate).toEqual(accepted);
    expect(testDb.database.prepare("SELECT COUNT(*) AS n FROM jobs").get()?.n).toBe(1);

    const claimed = await queue.claimNextJob([]);
    expect(claimed?.id).toBe(accepted.jobId);
    const revision = {
      name: "Agent test",
      steps: [{ id: "proof", name: "proof", run: "printf 'agent-worker-proof'", timeoutMs: 5000 }],
    } as any;
    await processJob({
      workerId: "worker-agent",
      job: claimed!,
      queue,
      secrets: new SecretStore(),
      config: {
        serverUrl: "http://127.0.0.1",
        storagePath: path.join(directory!, "storage"),
        tags: [],
        env: {},
        plugins: [],
      } as any,
      driver: new StandardProcessDriver(),
      workflow: revision,
    } as any);
    const terminal = await queue.getJob(accepted.jobId!);
    expect(terminal?.status).toBe("success");
    const report = JSON.parse(terminal?.report as string);
    expect(report.steps).toEqual(
      expect.arrayContaining([expect.objectContaining({ id: "proof", status: "success", exitCode: 0 })]),
    );
    const attemptLog = testDb.database
      .prepare("SELECT log_content FROM step_execution_attempts WHERE job_id = ? AND step_id = 'proof'")
      .get(accepted.jobId)?.log_content;
    expect(attemptLog).toContain("agent-worker-proof");
    const linked = await admission.get(accepted.eventId, 0);
    expect(linked).toMatchObject({ status: "admitted", admissionOutcome: "accepted", jobId: accepted.jobId });
    expect(accepted.jobId).toBe(terminal?.id);
    expect(await grants.has("workspace-a", "agent-a", "wf")).toBe(true);
    expect(await grants.has("workspace-b", "agent-a", "wf")).toBe(false);
  });
});
