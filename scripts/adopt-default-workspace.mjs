#!/usr/bin/env node

import { fileURLToPath } from "node:url";

const VERSION = "default-to-workspace-v1";
const SOURCE_WORKSPACE = "default";

export function parseArgs(argv) {
  const values = new Map();
  for (let index = 0; index < argv.length; index += 1) {
    const value = argv[index];
    if (value === "--dry-run" || value === "--apply") {
      values.set(value, true);
    } else if (value === "--workspace-id" && argv[index + 1]) {
      values.set(value, argv[++index]);
    } else {
      throw new Error(`Unexpected argument: ${value}`);
    }
  }
  if (!values.has("--workspace-id")) {
    throw new Error("Usage: pnpm workspace:adopt --workspace-id <id> (--dry-run | --apply)");
  }
  if (values.has("--dry-run") === values.has("--apply")) {
    throw new Error("Choose exactly one of --dry-run or --apply");
  }
  return { apply: values.has("--apply"), workspaceId: values.get("--workspace-id") };
}

export function databaseClient(moduleUrl) {
  const baseUrl = new URL("./", moduleUrl);
  const token = process.env.DB_AUTH_TOKEN || "";
  const endpoint = new URL("query", baseUrl);
  const request = async (payload) => {
    const response = await fetch(endpoint, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        ...(token ? { authorization: `Bearer ${token}` } : {}),
      },
      body: JSON.stringify(payload),
    });
    if (!response.ok) {
      throw new Error(`Database request failed with HTTP ${response.status}`);
    }
    return response.json();
  };
  return {
    all: (sql, data = []) => request({ s: sql, d: data, m: "all" }),
    get: (sql, data = []) => request({ s: sql, d: data, m: "get" }),
    transaction: (statements) => request({ t: statements }),
  };
}

export async function inspect(db, workspaceId) {
  if (!/^[A-Za-z0-9_-]{1,100}$/.test(workspaceId) || workspaceId === SOURCE_WORKSPACE) {
    throw new Error("Target must be a valid non-default workspace ID");
  }

  const tables = new Set((await db.all("SELECT name FROM sqlite_master WHERE type = 'table'")).map((row) => row.name));
  const requiredTables = [
    "teams",
    "oidc_users",
    "team_members",
    "workflows",
    "jobs",
    "workflow_revisions",
    "scheduled_runs",
    "secrets",
    "team_secrets",
    "api_keys",
  ];
  const missingTables = requiredTables.filter((table) => !tables.has(table));
  if (missingTables.length) {
    throw new Error(`Workspace schema is not initialized; missing tables: ${missingTables.join(", ")}`);
  }

  const target = await db.get("SELECT id FROM teams WHERE id = ?", [workspaceId]);
  if (!target) {
    throw new Error("Target workspace does not exist");
  }

  if (tables.has("workspace_adoptions")) {
    const existing = await db.get(
      "SELECT version, source_workspace_id, target_workspace_id FROM workspace_adoptions WHERE version = ?",
      [VERSION],
    );
    if (existing) {
      if (existing.source_workspace_id !== SOURCE_WORKSPACE || existing.target_workspace_id !== workspaceId) {
        throw new Error("This database was already adopted to a different workspace");
      }
      return { alreadyApplied: true, counts: {}, collisions: {} };
    }
  }

  const count = async (sql, data = []) => Number((await db.get(sql, data))?.count || 0);
  const ownedCount = async (table) =>
    tables.has(table) ? count(`SELECT COUNT(*) AS count FROM ${table} WHERE team_id = ?`, [SOURCE_WORKSPACE]) : 0;

  const counts = {
    workflows: await ownedCount("workflows"),
    jobs: await ownedCount("jobs"),
    secrets: await ownedCount("team_secrets"),
    legacySecrets: await count("SELECT COUNT(*) AS count FROM secrets"),
    apiKeys: await ownedCount("api_keys"),
    memberships: await ownedCount("team_members"),
    pushSubscriptions: await ownedCount("team_push_subscriptions"),
    workspaceWebhooks: await ownedCount("workspace_webhooks"),
    invitations: await ownedCount("team_invitations"),
    runnerGrants: await ownedCount("runner_team_grants"),
    teamRunnerEnrollments: tables.has("runner_enrollments")
      ? await count("SELECT COUNT(*) AS count FROM runner_enrollments WHERE scope = 'team' AND team_id = ?", [
          SOURCE_WORKSPACE,
        ])
      : 0,
    teamRunners: 0,
    activeJobs: await count(
      "SELECT COUNT(*) AS count FROM jobs WHERE team_id = ? AND status IN ('pending', 'running')",
      [SOURCE_WORKSPACE],
    ),
    orphanJobs: await count(
      "SELECT COUNT(*) AS count FROM jobs j LEFT JOIN workflows w ON w.id = j.workflow_id WHERE j.team_id = ? AND w.id IS NULL",
      [SOURCE_WORKSPACE],
    ),
    workflowRevisions: tables.has("workflow_revisions")
      ? await count(
          "SELECT COUNT(*) AS count FROM workflow_revisions r JOIN workflows w ON w.id = r.workflow_id WHERE w.team_id = ?",
          [SOURCE_WORKSPACE],
        )
      : 0,
    scheduledRuns: tables.has("scheduled_runs")
      ? await count(
          "SELECT COUNT(*) AS count FROM scheduled_runs s JOIN workflows w ON w.id = s.workflow_id WHERE w.team_id = ?",
          [SOURCE_WORKSPACE],
        )
      : 0,
    stepLogs: tables.has("step_logs")
      ? await count("SELECT COUNT(*) AS count FROM step_logs l JOIN jobs j ON j.id = l.job_id WHERE j.team_id = ?", [
          SOURCE_WORKSPACE,
        ])
      : 0,
    storedFiles: tables.has("stored_files")
      ? await count(
          "SELECT COUNT(*) AS count FROM stored_files f JOIN jobs j ON j.id = f.owner_key WHERE j.team_id = ?",
          [SOURCE_WORKSPACE],
        )
      : 0,
  };

  const invalidMemberships = await count(
    `SELECT COUNT(*) AS count FROM team_members m LEFT JOIN oidc_users u ON u.subject = m.subject
     WHERE m.team_id = ? AND u.subject IS NULL`,
    [SOURCE_WORKSPACE],
  );
  const invalidRunnerGrants = tables.has("runner_team_grants")
    ? await count(
        `SELECT COUNT(*) AS count FROM runner_team_grants g LEFT JOIN runners r ON r.id = g.runner_id
         WHERE g.team_id = ? AND r.id IS NULL`,
        [SOURCE_WORKSPACE],
      )
    : 0;

  const collisions = {
    secrets: await count(
      `SELECT COUNT(*) AS count FROM team_secrets source JOIN team_secrets target ON target.name = source.name
       WHERE source.team_id = ? AND target.team_id = ?`,
      [SOURCE_WORKSPACE, workspaceId],
    ),
    subscriptions: tables.has("team_push_subscriptions")
      ? await count(
          `SELECT COUNT(*) AS count FROM team_push_subscriptions source
           JOIN team_push_subscriptions target ON target.endpoint = source.endpoint
           WHERE source.team_id = ? AND target.team_id = ? AND
             (source.p256dh != target.p256dh OR source.auth != target.auth)`,
          [SOURCE_WORKSPACE, workspaceId],
        )
      : 0,
    legacySecretCopies: await count(
      `SELECT COUNT(*) AS count FROM secrets source LEFT JOIN team_secrets migrated
         ON migrated.team_id = ? AND migrated.name = source.name
       WHERE migrated.name IS NULL OR migrated.ciphertext != source.ciphertext
         OR COALESCE(migrated.encoding, 'utf8') != COALESCE(source.encoding, 'utf8')`,
      [SOURCE_WORKSPACE],
    ),
  };

  if (tables.has("runners")) {
    counts.teamRunners = await count("SELECT COUNT(*) AS count FROM runners WHERE scope = 'team' AND team_id = ?", [
      SOURCE_WORKSPACE,
    ]);
  }

  const conflicts = Object.entries(collisions).filter(([, value]) => value > 0);
  if (invalidMemberships || invalidRunnerGrants) {
    throw new Error(`Invalid references found: memberships=${invalidMemberships}, runnerGrants=${invalidRunnerGrants}`);
  }
  if (counts.activeJobs > 0) {
    throw new Error(`Cannot adopt while ${counts.activeJobs} default-workspace job(s) are pending or running`);
  }
  if (conflicts.length) {
    throw new Error(`Adoption conflicts found: ${conflicts.map(([name, value]) => `${name}=${value}`).join(", ")}`);
  }

  return { alreadyApplied: false, counts, collisions };
}

function statement(sql, data = []) {
  return { s: sql, d: data, m: "run" };
}

export async function adopt(db, workspaceId, tables) {
  const steps = [
    statement(
      `CREATE TABLE IF NOT EXISTS workspace_adoptions (
        version TEXT PRIMARY KEY,
        source_workspace_id TEXT NOT NULL,
        target_workspace_id TEXT NOT NULL REFERENCES teams(id),
        applied_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
        CHECK (source_workspace_id = 'default'),
        CHECK (target_workspace_id != 'default')
      )`,
    ),
    statement("INSERT INTO workspace_adoptions (version, source_workspace_id, target_workspace_id) VALUES (?, ?, ?)", [
      VERSION,
      SOURCE_WORKSPACE,
      workspaceId,
    ]),
    statement("UPDATE workflows SET team_id = ? WHERE team_id = ?", [workspaceId, SOURCE_WORKSPACE]),
    statement("UPDATE jobs SET team_id = ? WHERE team_id = ?", [workspaceId, SOURCE_WORKSPACE]),
    statement("UPDATE team_secrets SET team_id = ? WHERE team_id = ?", [workspaceId, SOURCE_WORKSPACE]),
    statement("UPDATE api_keys SET team_id = ? WHERE team_id = ?", [workspaceId, SOURCE_WORKSPACE]),
  ];

  if (tables.has("team_push_subscriptions")) {
    steps.push(
      statement(
        `INSERT OR IGNORE INTO team_push_subscriptions (team_id, endpoint, p256dh, auth, created_at)
         SELECT ?, endpoint, p256dh, auth, created_at FROM team_push_subscriptions WHERE team_id = ?`,
        [workspaceId, SOURCE_WORKSPACE],
      ),
      statement("DELETE FROM team_push_subscriptions WHERE team_id = ?", [SOURCE_WORKSPACE]),
    );
  }
  if (tables.has("workspace_webhooks")) {
    steps.push(
      statement("UPDATE workspace_webhooks SET team_id = ? WHERE team_id = ?", [workspaceId, SOURCE_WORKSPACE]),
    );
  }
  if (tables.has("team_invitations")) {
    steps.push(statement("UPDATE team_invitations SET team_id = ? WHERE team_id = ?", [workspaceId, SOURCE_WORKSPACE]));
  }

  steps.push(
    statement(
      `INSERT INTO team_members (team_id, subject, role, created_at)
       SELECT ?, subject, role, created_at FROM team_members WHERE team_id = ?
       ON CONFLICT(team_id, subject) DO UPDATE SET
         role = CASE WHEN team_members.role = 'admin' OR excluded.role = 'admin' THEN 'admin' ELSE 'member' END,
         created_at = CASE WHEN team_members.created_at < excluded.created_at THEN team_members.created_at ELSE excluded.created_at END`,
      [workspaceId, SOURCE_WORKSPACE],
    ),
    statement("DELETE FROM team_members WHERE team_id = ?", [SOURCE_WORKSPACE]),
  );

  if (tables.has("runner_team_grants")) {
    steps.push(
      statement(
        `INSERT OR IGNORE INTO runner_team_grants (runner_id, team_id, created_by, created_at)
         SELECT runner_id, ?, created_by, created_at FROM runner_team_grants WHERE team_id = ?`,
        [workspaceId, SOURCE_WORKSPACE],
      ),
      statement("DELETE FROM runner_team_grants WHERE team_id = ?", [SOURCE_WORKSPACE]),
    );
  }
  if (tables.has("runner_enrollments")) {
    steps.push(
      statement("UPDATE runner_enrollments SET team_id = ? WHERE scope = 'team' AND team_id = ?", [
        workspaceId,
        SOURCE_WORKSPACE,
      ]),
    );
  }
  if (tables.has("runners")) {
    steps.push(
      statement("UPDATE runners SET team_id = ? WHERE scope = 'team' AND team_id = ?", [workspaceId, SOURCE_WORKSPACE]),
    );
  }

  // The legacy unscoped table is copied to team_secrets at startup. Clear its rows
  // after preserving the encrypted team-scoped copy, or the next boot would seed
  // those values back into the compatibility workspace.
  steps.push(statement("DELETE FROM secrets"));

  await db.transaction(steps);
}

async function main() {
  const { apply, workspaceId } = parseArgs(process.argv.slice(2));
  const databaseUrl = process.env.DATABASE_URL;
  if (!databaseUrl) {
    throw new Error("Set DATABASE_URL to the isolated cloned database module URL");
  }
  const db = databaseClient(databaseUrl);
  const details = await inspect(db, workspaceId);
  if (details.alreadyApplied) {
    console.log(`Already adopted to workspace ${workspaceId}; no changes made.`);
    return;
  }
  console.log(JSON.stringify({ targetWorkspace: workspaceId, mode: apply ? "apply" : "dry-run", ...details }, null, 2));
  if (apply) {
    await adopt(
      db,
      workspaceId,
      new Set((await db.all("SELECT name FROM sqlite_master WHERE type = 'table'")).map((row) => row.name)),
    );
    console.log(
      "Adoption committed atomically. Workflow/job IDs, revisions, logs, file references, secret ciphertext, and API-key hashes were retained.",
    );
  } else {
    console.log("Dry run only. Re-run with --apply to adopt this workspace.");
  }
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  main().catch((error) => {
    console.error(`Workspace adoption failed: ${error.message}`);
    process.exitCode = 1;
  });
}
