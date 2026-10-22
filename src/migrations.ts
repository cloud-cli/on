import db from "./db-client.js";
import YAML from "yaml";

type Migration = {
  version: string;
  apply: () => Promise<void>;
};

function canonicalWorkflowId(value: unknown): string {
  if (typeof value !== "string" || !value.trim()) {
    throw new Error("Workflow ID migration encountered a missing or invalid ID");
  }
  const id = value
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
  if (!id || id.length > 128) {
    throw new Error("Workflow ID migration encountered an ID outside the supported format");
  }
  return id;
}

function withWorkflowId(sourceYaml: string, id: string): string {
  const line = `id: ${JSON.stringify(id)}`;
  let updated: string;
  if (/^id\s*:/m.test(sourceYaml)) {
    updated = sourceYaml.replace(/^id\s*:.*/m, line);
  } else {
    const nameLine = sourceYaml.search(/^name\s*:/m);
    if (nameLine < 0) {
      throw new Error("Workflow ID migration could not find a top-level name field");
    }
    updated = `${sourceYaml.slice(0, nameLine)}${line}\n${sourceYaml.slice(nameLine)}`;
  }
  if (yamlWorkflowId(updated) !== id) {
    throw new Error("Workflow ID migration could not safely add a top-level ID");
  }
  return updated;
}

function yamlWorkflowId(sourceYaml: string): string | undefined {
  const parsed = YAML.parse(sourceYaml);
  return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed.id : undefined;
}

const migrations: Migration[] = [
  {
    version: "001_add_workflow_enabled",
    async apply() {
      const columns = await db.all("PRAGMA table_info(workflows)");
      if (!columns.some((column: any) => column.name === "enabled")) {
        await db.run("ALTER TABLE workflows ADD COLUMN enabled INTEGER NOT NULL DEFAULT 1");
      }
    },
  },
  {
    version: "002_add_push_subscriptions",
    async apply() {
      await db.exec(`
        CREATE TABLE IF NOT EXISTS push_subscriptions (
          endpoint TEXT PRIMARY KEY,
          p256dh TEXT NOT NULL,
          auth TEXT NOT NULL,
          created_at DATETIME DEFAULT CURRENT_TIMESTAMP
        )
      `);
    },
  },
  {
    version: "003_add_push_delivery_history",
    async apply() {
      await db.exec(`
        CREATE TABLE IF NOT EXISTS push_deliveries (
          job_id INTEGER PRIMARY KEY,
          delivered_at DATETIME DEFAULT CURRENT_TIMESTAMP
        )
      `);
    },
  },
  {
    version: "004_add_ai_requests",
    async apply() {
      await db.exec(`
        CREATE TABLE IF NOT EXISTS ai_requests (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          job_id INTEGER NOT NULL,
          workflow_url TEXT NOT NULL,
          request_json TEXT NOT NULL,
          created_at DATETIME DEFAULT CURRENT_TIMESTAMP
        );
        CREATE INDEX IF NOT EXISTS idx_ai_requests_job ON ai_requests(job_id);
      `);
    },
  },
  {
    version: "005_add_teams",
    async apply() {
      await db.exec(`
        CREATE TABLE IF NOT EXISTS oidc_users (
          subject TEXT PRIMARY KEY, email TEXT, name TEXT, photo TEXT,
          role TEXT NOT NULL DEFAULT 'user', created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
          updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
        );
        CREATE TABLE IF NOT EXISTS teams (
          id TEXT PRIMARY KEY, name TEXT NOT NULL, webhook_token TEXT NOT NULL UNIQUE,
          created_at DATETIME DEFAULT CURRENT_TIMESTAMP
        );
        CREATE TABLE IF NOT EXISTS team_members (
          team_id TEXT NOT NULL REFERENCES teams(id) ON DELETE CASCADE,
          subject TEXT NOT NULL REFERENCES oidc_users(subject) ON DELETE CASCADE,
          role TEXT NOT NULL CHECK(role IN ('admin','member')),
          created_at DATETIME DEFAULT CURRENT_TIMESTAMP, PRIMARY KEY(team_id, subject)
        );
        CREATE TABLE IF NOT EXISTS team_invitations (
          id TEXT PRIMARY KEY, team_id TEXT NOT NULL REFERENCES teams(id) ON DELETE CASCADE,
          email TEXT NOT NULL, token_hash TEXT NOT NULL UNIQUE, expires_at DATETIME NOT NULL,
          accepted_at DATETIME, created_by TEXT NOT NULL, created_at DATETIME DEFAULT CURRENT_TIMESTAMP
        );
        CREATE INDEX IF NOT EXISTS idx_team_invitations_expiry ON team_invitations(expires_at);
      `);
    },
  },
  {
    version: "006_scope_push_subscriptions_to_teams",
    async apply() {
      const legacy = await db.get("SELECT 1 AS present FROM push_subscriptions LIMIT 1");
      if (legacy) {
        throw new Error("Legacy push subscriptions require explicit workspace assignment");
      }
      await db.exec(`
        CREATE TABLE IF NOT EXISTS team_push_subscriptions (
          team_id TEXT NOT NULL REFERENCES teams(id) ON DELETE CASCADE, endpoint TEXT NOT NULL, p256dh TEXT NOT NULL, auth TEXT NOT NULL,
          created_at DATETIME DEFAULT CURRENT_TIMESTAMP, PRIMARY KEY(team_id, endpoint)
        );
        CREATE INDEX IF NOT EXISTS idx_team_push_subscriptions_team ON team_push_subscriptions(team_id);
      `);
    },
  },
  {
    version: "007_scope_api_keys_to_teams",
    async apply() {
      const tables = await db.all("PRAGMA table_info(api_keys)");
      if (tables.length && !tables.some((column: any) => column.name === "team_id")) {
        const rows = await db.get("SELECT 1 AS present FROM api_keys LIMIT 1");
        if (rows) {
          throw new Error(
            "Cannot add workspace ownership to populated api_keys: explicit workspace assignment required",
          );
        }
        await db.run("ALTER TABLE api_keys ADD COLUMN team_id TEXT NOT NULL REFERENCES teams(id)");
      }
    },
  },
  {
    version: "008_workflows_team_foreign_key",
    async apply() {
      // Legacy populated workflows need an explicit workspace assignment.
      const columns = await db.all("PRAGMA table_info(workflows)");
      if (!columns.some((column: any) => column.name === "team_id")) {
        const rows = await db.get("SELECT id FROM workflows LIMIT 1");
        if (rows) {
          throw new Error(
            "Cannot add workspace ownership to populated workflows: explicit workspace assignment required",
          );
        }
        await db.run("ALTER TABLE workflows ADD COLUMN team_id TEXT NOT NULL REFERENCES teams(id) ON DELETE RESTRICT");
      }
      const orphans = await db.all(
        "SELECT workflows.id, workflows.team_id FROM workflows LEFT JOIN teams ON teams.id = workflows.team_id WHERE teams.id IS NULL LIMIT 1",
      );
      if (orphans.length) {
        throw new Error(
          `Cannot enforce workflows.team_id foreign key: workflow ${orphans[0].id} has missing team ${orphans[0].team_id}`,
        );
      }
      const definition = await db.get("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'workflows'");
      if (!definition?.sql) {
        throw new Error("Cannot enforce workflows.team_id foreign key: workflows table is missing");
      }
      if (/FOREIGN\s+KEY\s*\(\s*team_id\s*\)/i.test(definition.sql)) {
        return;
      }
      const indexes = await db.all(
        "SELECT sql FROM sqlite_master WHERE type = 'index' AND tbl_name = 'workflows' AND sql IS NOT NULL",
      );
      const original = definition.sql.replace(
        /CREATE\s+TABLE\s+(?:IF\s+NOT\s+EXISTS\s+)?["'`\[]?workflows["'`\]]?/i,
        "CREATE TABLE workflows",
      );
      const closingParen = original.lastIndexOf(")");
      if (closingParen < 0) {
        throw new Error("Cannot enforce workflows.team_id foreign key: unrecognized workflows schema");
      }
      const constrained = `${original.slice(0, closingParen)}, FOREIGN KEY (team_id) REFERENCES teams(id) ON DELETE RESTRICT${original.slice(closingParen)}`;
      const columnsWithOwnership = await db.all("PRAGMA table_info(workflows)");
      const names = columnsWithOwnership.map((column: any) => column.name);
      const list = names.map((name: string) => `\"${name.replace(/\"/g, '\"\"')}\"`).join(", ");
      const replacementTable = constrained.replace(
        /^CREATE TABLE workflows\b/i,
        "CREATE TABLE workflows_after_team_fk",
      );
      if (typeof db.transaction !== "function") {
        throw new Error("Cannot enforce workflows.team_id foreign key: database transactions are required");
      }
      await db.transaction([
        { s: replacementTable, m: "run" },
        { s: `INSERT INTO workflows_after_team_fk (${list}) SELECT ${list} FROM workflows`, m: "run" },
        { s: "DROP TABLE workflows", m: "run" },
        { s: "ALTER TABLE workflows_after_team_fk RENAME TO workflows", m: "run" },
        ...indexes.map((index: any) => ({ s: index.sql, m: "run" })),
      ]);
    },
  },
  {
    version: "009_workflow_definition_ids",
    async apply() {
      const columns = await db.all("PRAGMA table_info(workflows)");
      const hasDefinitionId = columns.some((column: any) => column.name === "definition_id");
      const workflowRows = await db.all(
        `SELECT id, team_id, source_yaml${hasDefinitionId ? ", definition_id" : ""} FROM workflows`,
      );
      const revisionRows = await db.all(
        "SELECT workflow_id, revision, source_yaml, normalized_json FROM workflow_revisions ORDER BY workflow_id, revision",
      );
      const latestRevision = new Map<string, any>();
      const statements: Array<{ s: string; d?: unknown[]; m: string }> = [];
      const plannedIds = new Map<string, string>();

      if (!hasDefinitionId) {
        statements.push({ s: "ALTER TABLE workflows ADD COLUMN definition_id TEXT", m: "run" });
      }

      for (const revision of revisionRows) {
        const definition = JSON.parse(revision.normalized_json);
        const sourceId = yamlWorkflowId(revision.source_yaml);
        const id = canonicalWorkflowId(sourceId || definition.id || revision.workflow_id);
        const sourceYaml = withWorkflowId(revision.source_yaml, id);
        definition.id = id;
        statements.push({
          s: "UPDATE workflow_revisions SET source_yaml = ?, normalized_json = ? WHERE workflow_id = ? AND revision = ?",
          d: [sourceYaml, JSON.stringify(definition), revision.workflow_id, revision.revision],
          m: "run",
        });
        latestRevision.set(revision.workflow_id, { id, revision: Number(revision.revision), sourceYaml });
      }

      for (const workflow of workflowRows) {
        const latest = latestRevision.get(workflow.id);
        const id = canonicalWorkflowId(
          yamlWorkflowId(workflow.source_yaml) || workflow.definition_id || latest?.id || workflow.id,
        );
        const teamId = workflow.team_id || "";
        const scopeKey = `${teamId}\u0000${id}`;
        const previousWorkflow = plannedIds.get(scopeKey);
        if (previousWorkflow && previousWorkflow !== workflow.id) {
          throw new Error(`Workflow ID migration found a duplicate ID in one workspace: ${id}`);
        }
        plannedIds.set(scopeKey, workflow.id);
        statements.push({
          s: "UPDATE workflows SET definition_id = ?, source_yaml = ? WHERE id = ?",
          d: [id, withWorkflowId(workflow.source_yaml, id), workflow.id],
          m: "run",
        });
        if (latest && latest.id !== id) {
          const revision = revisionRows.find(
            (row: any) => row.workflow_id === workflow.id && Number(row.revision) === latest.revision,
          );
          const definition = JSON.parse(revision.normalized_json);
          definition.id = id;
          statements.push({
            s: "UPDATE workflow_revisions SET source_yaml = ?, normalized_json = ? WHERE workflow_id = ? AND revision = ?",
            d: [withWorkflowId(revision.source_yaml, id), JSON.stringify(definition), workflow.id, latest.revision],
            m: "run",
          });
        }
      }

      if (typeof db.transaction !== "function") {
        throw new Error("Workflow ID migration requires database transactions");
      }
      statements.push(
        {
          s: "CREATE UNIQUE INDEX IF NOT EXISTS idx_workflows_team_definition_id ON workflows(team_id, definition_id)",
          m: "run",
        },
        {
          s: `CREATE TRIGGER IF NOT EXISTS workflows_definition_id_required_insert
              BEFORE INSERT ON workflows WHEN NEW.definition_id IS NULL OR trim(NEW.definition_id) = ''
              BEGIN SELECT RAISE(ABORT, 'Workflow definition ID is required'); END`,
          m: "run",
        },
        {
          s: `CREATE TRIGGER IF NOT EXISTS workflows_definition_id_required_update
              BEFORE UPDATE OF definition_id ON workflows WHEN NEW.definition_id IS NULL OR trim(NEW.definition_id) = ''
              BEGIN SELECT RAISE(ABORT, 'Workflow definition ID is required'); END`,
          m: "run",
        },
      );
      await db.transaction(statements);
    },
  },
  {
    version: "010_unified_principals_and_permissions",
    async apply() {
      const statements: Array<{ s: string; d?: unknown[]; m: string }> = [];
      // Human and system principals share one directory. System users have a
      // synthetic subject and can never hold a global administrator role.
      const userColumns = await db.all("PRAGMA table_info(oidc_users)");
      if (userColumns.length) {
        const names = new Set(userColumns.map((column: any) => column.name));
        if (!names.has("kind")) {
          statements.push({ s: "ALTER TABLE oidc_users ADD COLUMN kind TEXT NOT NULL DEFAULT 'human'", m: "run" });
        }
        if (!names.has("disabled_at")) {
          statements.push({ s: "ALTER TABLE oidc_users ADD COLUMN disabled_at DATETIME", m: "run" });
        }
        if (!names.has("created_by")) {
          statements.push({ s: "ALTER TABLE oidc_users ADD COLUMN created_by TEXT", m: "run" });
        }
      }

      const membership = await db.get("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'team_members'");
      const membershipSql = typeof membership?.sql === "string" ? membership.sql : "";
      if (membershipSql && (!membershipSql.includes("'viewer'") || !membershipSql.includes("'collaborator'"))) {
        const columns = await db.all("PRAGMA table_info(team_members)");
        const names = columns.map((column: any) => column.name);
        const required = ["team_id", "subject", "role", "created_at"];
        if (!required.every((name) => names.includes(name))) {
          throw new Error("Cannot migrate legacy workspace membership: required columns are missing");
        }
        {
          const copy = `INSERT INTO team_members_v2 (team_id, subject, role, created_at)
            SELECT team_id, subject, CASE WHEN role = 'admin' THEN 'admin' ELSE 'collaborator' END,
                   COALESCE(created_at, CURRENT_TIMESTAMP)
            FROM team_members`;
          statements.push(
            {
              s: `CREATE TABLE team_members_v2 (
                team_id TEXT NOT NULL REFERENCES teams(id) ON DELETE CASCADE,
                subject TEXT NOT NULL REFERENCES oidc_users(subject) ON DELETE CASCADE,
                role TEXT NOT NULL CHECK(role IN ('viewer','collaborator','admin')),
                created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
                PRIMARY KEY(team_id, subject)
              )`,
              m: "run",
            },
            { s: copy, m: "run" },
            { s: "DROP TABLE team_members", m: "run" },
            { s: "ALTER TABLE team_members_v2 RENAME TO team_members", m: "run" },
          );
        }
      }

      statements.push(
        {
          s: `CREATE TABLE IF NOT EXISTS workspace_permission_overrides (
          team_id TEXT NOT NULL REFERENCES teams(id) ON DELETE CASCADE,
          subject TEXT NOT NULL REFERENCES oidc_users(subject) ON DELETE CASCADE,
          capability TEXT NOT NULL,
          effect TEXT NOT NULL CHECK(effect IN ('allow','deny')),
          granted_by TEXT,
          created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
          PRIMARY KEY(team_id, subject, capability)
        )`,
          m: "run",
        },
        {
          s: "CREATE INDEX IF NOT EXISTS idx_workspace_permission_overrides_subject ON workspace_permission_overrides(subject, team_id)",
          m: "run",
        },
        {
          s: `CREATE TABLE IF NOT EXISTS principal_tokens (
          id TEXT PRIMARY KEY,
          subject TEXT NOT NULL REFERENCES oidc_users(subject) ON DELETE CASCADE,
          name TEXT NOT NULL,
          token_hash TEXT NOT NULL UNIQUE,
          created_by TEXT NOT NULL,
          created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
          last_used_at DATETIME,
          revoked_at DATETIME
        )`,
          m: "run",
        },
        {
          s: "CREATE INDEX IF NOT EXISTS idx_principal_tokens_subject ON principal_tokens(subject, revoked_at)",
          m: "run",
        },
        {
          s: `CREATE TABLE IF NOT EXISTS authorization_audit (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          actor TEXT,
          action TEXT NOT NULL,
          target TEXT,
          team_id TEXT,
          detail TEXT,
          created_at DATETIME DEFAULT CURRENT_TIMESTAMP
        )`,
          m: "run",
        },
        {
          s: "CREATE INDEX IF NOT EXISTS idx_authorization_audit_team ON authorization_audit(team_id, created_at)",
          m: "run",
        },
      );

      // Legacy workspace keys have no owner, so they cannot provide principal
      // parity. Disable every one instead of guessing an owner.
      const keyColumns = await db.all("PRAGMA table_info(api_keys)");
      if (keyColumns.some((column: any) => column.name === "revoked_at")) {
        statements.push({ s: "UPDATE api_keys SET revoked_at = CURRENT_TIMESTAMP WHERE revoked_at IS NULL", m: "run" });
      }
      if (statements.length) {
        if (typeof db.transaction !== "function") {
          throw new Error("Atomic transactions are required for migration 010");
        }
        await db.transaction(statements);
      }
    },
  },
  {
    version: "011_workspace_deletion_fence",
    async apply() {
      const columns = await db.all("PRAGMA table_info(teams)");
      if (!columns.length) {
        throw new Error("Cannot apply workspace deletion fence: teams table is missing");
      }
      if (columns.some((column: any) => column.name === "deleting_at")) {
        return;
      }
      if (typeof db.transaction !== "function") {
        throw new Error("Atomic transactions are required for migration 011");
      }
      await db.transaction([{ s: "ALTER TABLE teams ADD COLUMN deleting_at DATETIME", m: "run" }]);
    },
  },

  {
    version: "012_retire_flow_system_principals",
    async apply() {
      const tables = await db.all("SELECT name FROM sqlite_master WHERE type = 'table'");
      const names = new Set(tables.map((table: any) => table.name));
      if (!names.has("oidc_users")) {
        return;
      }
      const statements: Array<{ s: string; m: string }> = [];
      if (names.has("principal_tokens")) {
        statements.push({
          s: "UPDATE principal_tokens SET revoked_at = COALESCE(revoked_at, CURRENT_TIMESTAMP) WHERE subject IN (SELECT subject FROM oidc_users WHERE kind = 'system')",
          m: "run",
        });
      }
      if (names.has("team_members")) {
        statements.push({
          s: "DELETE FROM team_members WHERE subject IN (SELECT subject FROM oidc_users WHERE kind = 'system')",
          m: "run",
        });
      }
      if (names.has("workspace_permission_overrides")) {
        statements.push({
          s: "DELETE FROM workspace_permission_overrides WHERE subject IN (SELECT subject FROM oidc_users WHERE kind = 'system')",
          m: "run",
        });
      }
      statements.push({
        s: "UPDATE oidc_users SET disabled_at = COALESCE(disabled_at, CURRENT_TIMESTAMP) WHERE kind = 'system'",
        m: "run",
      });
      if (typeof db.transaction !== "function") {
        throw new Error("Atomic transactions are required for migration 012");
      }
      await db.transaction(statements);
    },
  },
  {
    version: "013_oidc_subject_workspace_invitations",
    async apply() {
      await db.exec(`CREATE TABLE IF NOT EXISTS team_subject_invitations (
        id TEXT PRIMARY KEY,
        team_id TEXT NOT NULL REFERENCES teams(id) ON DELETE CASCADE,
        subject TEXT NOT NULL,
        expires_at DATETIME NOT NULL,
        created_by TEXT NOT NULL,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        UNIQUE(team_id, subject)
      );
      CREATE INDEX IF NOT EXISTS idx_team_subject_invitations_subject_expiry
        ON team_subject_invitations(subject, expires_at);`);
    },
  },
  {
    version: "014_incoming_event_inbox",
    async apply() {
      await db.exec(`
        CREATE TABLE IF NOT EXISTS incoming_events (
          id TEXT PRIMARY KEY,
          team_id TEXT NOT NULL REFERENCES teams(id) ON DELETE CASCADE,
          provider TEXT NOT NULL,
          delivery_id TEXT,
          event_type TEXT,
          content_type TEXT,
          received_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
          payload_ciphertext TEXT NOT NULL,
          inputs_ciphertext TEXT,
          payload_sha256 TEXT NOT NULL,
          payload_bytes INTEGER NOT NULL,
          validation_status TEXT NOT NULL DEFAULT 'pending'
            CHECK (validation_status IN ('pending', 'valid', 'invalid')),
          processing_status TEXT NOT NULL DEFAULT 'received'
            CHECK (processing_status IN ('received', 'queued', 'unmatched', 'rejected', 'failed')),
          queued_jobs INTEGER NOT NULL DEFAULT 0,
          job_ids TEXT NOT NULL DEFAULT '[]',
          error TEXT
        );
        CREATE INDEX IF NOT EXISTS idx_incoming_events_team_received
          ON incoming_events(team_id, received_at DESC, id DESC);
        CREATE INDEX IF NOT EXISTS idx_incoming_events_team_delivery
          ON incoming_events(team_id, provider, delivery_id);
        CREATE TABLE IF NOT EXISTS incoming_event_replays (
          id TEXT PRIMARY KEY,
          event_id TEXT NOT NULL REFERENCES incoming_events(id) ON DELETE CASCADE,
          team_id TEXT NOT NULL REFERENCES teams(id) ON DELETE CASCADE,
          actor TEXT NOT NULL,
          created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
          status TEXT NOT NULL DEFAULT 'pending'
            CHECK (status IN ('pending', 'queued', 'unmatched', 'failed')),
          queued_jobs INTEGER NOT NULL DEFAULT 0,
          job_ids TEXT NOT NULL DEFAULT '[]',
          error TEXT
        );
        CREATE INDEX IF NOT EXISTS idx_incoming_event_replays_event
          ON incoming_event_replays(team_id, event_id, created_at DESC);
      `);
    },
  },
];

export async function runMigrations(): Promise<void> {
  await db.exec(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      version TEXT PRIMARY KEY,
      applied_at DATETIME DEFAULT CURRENT_TIMESTAMP
    )
  `);

  const applied = new Set((await db.all("SELECT version FROM schema_migrations")).map((row: any) => row.version));
  for (const migration of migrations) {
    if (applied.has(migration.version)) {
      continue;
    }
    await migration.apply();
    await db.run("INSERT INTO schema_migrations (version) VALUES (?)", [migration.version]);
  }
}
