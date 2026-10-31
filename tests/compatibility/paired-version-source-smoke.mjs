import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, symlinkSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { DatabaseSync } from "node:sqlite";

const rollbackRevision = "fce2a08b9001ba3edda78f3b638b08ec8e61cc88";
const root = process.cwd();
const temporaryRoot = mkdtempSync(path.join("/tmp/opencode", "on-compatibility-smoke-"));
const oldRoot = path.join(temporaryRoot, "old");
const currentRoot = path.join(temporaryRoot, "current");
const databasePath = path.join(temporaryRoot, "compatibility.sqlite");
const adapterPath = path.join(temporaryRoot, "sqlite-adapter.mjs");
let adapter;

function git(args) {
  execFileSync("git", args, { cwd: root, stdio: "ignore" });
}

function createWorktree(directory, revision) {
  git(["worktree", "add", "--detach", directory, revision]);
  symlinkSync(path.join(root, "node_modules"), path.join(directory, "node_modules"), "dir");
}

try {
  git(["cat-file", "-e", `${rollbackRevision}^{commit}`]);
  createWorktree(oldRoot, rollbackRevision);
  createWorktree(currentRoot, "HEAD");

  // The temporary adapter keeps this smoke test fully isolated from DATABASE_URL and production services.
  const adapterSource = `
    import { DatabaseSync } from "node:sqlite";
    const database = new DatabaseSync(process.env.PAIRED_VERSION_TEST_DB);
    database.exec("PRAGMA foreign_keys = ON");
    export const get = async (sql, values = []) => database.prepare(sql).get(...values);
    export const all = async (sql, values = []) => database.prepare(sql).all(...values);
    export const run = async (sql, values = []) => database.prepare(sql).run(...values);
    export const exec = async (sql) => database.exec(sql);
    export const transaction = async (statements) => {
      database.exec("BEGIN IMMEDIATE");
      try {
        const results = statements.map((statement) => statement.m === "exec"
          ? (database.exec(statement.s), undefined)
          : database.prepare(statement.s).run(...(statement.d || [])));
        database.exec("COMMIT");
        return results;
      } catch (error) {
        database.exec("ROLLBACK");
        throw error;
      }
    };
    export const pragma = async (statement) => database.prepare("PRAGMA " + statement).all();
    export const close = () => database.close();
    export default { get, all, run, exec, transaction, pragma, close };
  `;
  const { writeFileSync } = await import("node:fs");
  writeFileSync(adapterPath, adapterSource);
  process.env.PAIRED_VERSION_TEST_DB = databasePath;
  process.env.DATABASE_URL = pathToFileURL(adapterPath).href;
  process.env.RUNNER_MASTER_KEY = "synthetic-paired-version-compatibility-key";
  process.env.OIDC_ISSUER = "";
  process.env.OIDC_CLIENT_ID = "";
  process.env.OIDC_CLIENT_SECRET = "";
  adapter = await import(pathToFileURL(adapterPath).href);

  await adapter.exec(`
    CREATE TABLE schema_migrations (version TEXT PRIMARY KEY, applied_at TEXT DEFAULT CURRENT_TIMESTAMP);
    CREATE TABLE teams (
      id TEXT PRIMARY KEY, name TEXT NOT NULL, webhook_token TEXT NOT NULL UNIQUE,
      created_at TEXT DEFAULT CURRENT_TIMESTAMP, deleting_at TEXT
    );
    CREATE TABLE team_members (
      team_id TEXT NOT NULL REFERENCES teams(id) ON DELETE CASCADE, subject TEXT NOT NULL,
      role TEXT NOT NULL, created_at TEXT DEFAULT CURRENT_TIMESTAMP, PRIMARY KEY (team_id, subject)
    );
    CREATE TABLE workflows (
      id TEXT PRIMARY KEY, definition_id TEXT, name TEXT NOT NULL, source_yaml TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'draft', active_revision INTEGER, enabled INTEGER NOT NULL DEFAULT 1,
      created_at TEXT DEFAULT CURRENT_TIMESTAMP, updated_at TEXT DEFAULT CURRENT_TIMESTAMP,
      team_id TEXT NOT NULL REFERENCES teams(id)
    );
    CREATE TABLE jobs (
      id INTEGER PRIMARY KEY AUTOINCREMENT, parentId INTEGER, workflow_id TEXT NOT NULL, workflow_revision INTEGER NOT NULL,
      required_tags TEXT NOT NULL DEFAULT '[]', payload TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'pending',
      concurrency_key TEXT, worker_id TEXT, report TEXT, created_at TEXT DEFAULT CURRENT_TIMESTAMP,
      updated_at TEXT DEFAULT CURRENT_TIMESTAMP, started_at TEXT DEFAULT CURRENT_TIMESTAMP,
      finished_at TEXT DEFAULT CURRENT_TIMESTAMP, team_id TEXT NOT NULL REFERENCES teams(id),
      lease_id TEXT, lease_token_hash TEXT, lease_expires_at TEXT, lease_fenced INTEGER NOT NULL DEFAULT 0,
      lease_completed INTEGER NOT NULL DEFAULT 0, dispatch_key TEXT UNIQUE
    );
    INSERT INTO teams(id, name, webhook_token) VALUES ('compat-team', 'Synthetic Compatibility Fixture', 'synthetic-token');
    INSERT INTO team_members(team_id, subject, role) VALUES ('compat-team', 'synthetic-user', 'admin');
    INSERT INTO schema_migrations(version) VALUES
      ('001_add_workflow_enabled'), ('002_add_push_subscriptions'), ('003_add_push_delivery_history'),
      ('004_add_ai_requests'), ('005_add_teams'), ('006_scope_push_subscriptions_to_teams'),
      ('007_scope_api_keys_to_teams'), ('008_workflows_team_foreign_key'), ('009_workflow_definition_ids'),
      ('010_unified_principals_and_permissions'), ('011_workspace_deletion_fence'),
      ('012_retire_flow_system_principals'), ('013_oidc_subject_workspace_invitations'),
      ('014_incoming_event_inbox');
  `);

  const oldQueueModule = await import(pathToFileURL(path.join(oldRoot, "src/queue.ts")).href);
  const oldWorkflowModule = await import(pathToFileURL(path.join(oldRoot, "src/workflows.ts")).href);
  const oldRecipeModule = await import(pathToFileURL(path.join(oldRoot, "src/recipes.ts")).href);
  const oldQueue = new oldQueueModule.QueueManager("paired-version-old-source");
  await oldQueue.init();
  await new oldWorkflowModule.WorkflowRepository().init();
  await new oldRecipeModule.RecipeRepository().init();

  await adapter.run(
    `INSERT INTO workflows(id, definition_id, name, source_yaml, status, active_revision, enabled, team_id)
     VALUES (?, ?, ?, ?, 'published', 1, 1, ?)`,
    [
      "compat-flow",
      "compat-flow",
      "Synthetic Compatibility Workflow",
      "name: Synthetic Compatibility Workflow",
      "compat-team",
    ],
  );
  await adapter.run(
    `INSERT INTO workflow_revisions(workflow_id, revision, source_yaml, normalized_json)
     VALUES (?, 1, ?, ?)`,
    [
      "compat-flow",
      "name: Synthetic Compatibility Workflow",
      JSON.stringify({ name: "Synthetic Compatibility Workflow", steps: [] }),
    ],
  );
  await adapter.run(
    `INSERT INTO jobs(id, team_id, workflow_id, workflow_revision, required_tags, payload, status)
     VALUES (?, ?, ?, 1, '[]', ?, 'success')`,
    [1001, "compat-team", "compat-flow", JSON.stringify({ inputs: { source: "legacy" } })],
  );

  // Apply newer migrations, including connector tables that the rollback target does not know about.
  const currentWorkflowModule = await import(pathToFileURL(path.join(currentRoot, "src/workflows.ts")).href);
  await new currentWorkflowModule.WorkflowRepository().init();
  const connectorTemplateCount = await adapter.get("SELECT COUNT(*) AS count FROM connector_template_versions");
  assert.ok(Number(connectorTemplateCount.count) > 0, "newer migration-created data exists before old-source probe");

  const historicalJob = await oldQueue.getJobForTeam("compat-team", 1001);
  assert.equal(Number(historicalJob?.id), 1001, "rollback-target source can read the historical job");
  await oldQueue.saveReport(1001, { steps: [{ id: "legacy-step", status: "success" }] });
  const oldEnqueuedJobId = await oldQueue.enqueue("compat-flow", 1, { inputs: { source: "written-by-old-source" } });

  const currentQueueModule = await import(pathToFileURL(path.join(currentRoot, "src/queue.ts")).href);
  const currentQueue = new currentQueueModule.QueueManager("paired-version-current-source");
  const observedReport = await currentQueue.getJobForTeam("compat-team", 1001);
  const observedOldEnqueue = await currentQueue.getJobForTeam("compat-team", oldEnqueuedJobId);
  assert.deepEqual(JSON.parse(observedReport.report).steps, [{ id: "legacy-step", status: "success" }]);
  assert.deepEqual(observedOldEnqueue.payload.inputs, { source: "written-by-old-source" });
  const connectorTemplateCountAfter = await adapter.get("SELECT COUNT(*) AS count FROM connector_template_versions");
  assert.equal(Number(connectorTemplateCountAfter.count), Number(connectorTemplateCount.count));
  const integrity = await adapter.get("PRAGMA integrity_check");
  assert.equal(integrity.integrity_check, "ok");

  console.log(
    JSON.stringify({
      rollbackRevision,
      currentRevision: execFileSync("git", ["rev-parse", "HEAD"], { cwd: root, encoding: "utf8" }).trim(),
      oldSourceReadHistoricalJob: true,
      oldSourceWroteReport: true,
      oldSourceEnqueuedJobId: oldEnqueuedJobId,
      currentSourceReadOldEnqueue: true,
      newerMigrationDataPreserved: true,
      sqliteIntegrity: integrity.integrity_check,
      productionDatabaseUsed: false,
      releaseBinaryStarted: false,
    }),
  );
} finally {
  adapter?.close();
  for (const worktree of [oldRoot, currentRoot]) {
    try {
      git(["worktree", "remove", "--force", worktree]);
    } catch {
      // The worktree may not have been created if setup failed early.
    }
  }
  rmSync(temporaryRoot, { recursive: true, force: true });
}
