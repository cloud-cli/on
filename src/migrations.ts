import db from "./db-client.js";
import { GITHUB_PUSH_TEMPLATE } from "./connector-templates.js";
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
          id TEXT PRIMARY KEY, name TEXT NOT NULL,
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
        {
          s: `INSERT INTO workflows_after_team_fk (${list}) SELECT ${list} FROM workflows`,
          m: "run",
        },
        { s: "DROP TABLE workflows", m: "run" },
        {
          s: "ALTER TABLE workflows_after_team_fk RENAME TO workflows",
          m: "run",
        },
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
        statements.push({
          s: "ALTER TABLE workflows ADD COLUMN definition_id TEXT",
          m: "run",
        });
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
        latestRevision.set(revision.workflow_id, {
          id,
          revision: Number(revision.revision),
          sourceYaml,
        });
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
          statements.push({
            s: "ALTER TABLE oidc_users ADD COLUMN kind TEXT NOT NULL DEFAULT 'human'",
            m: "run",
          });
        }
        if (!names.has("disabled_at")) {
          statements.push({
            s: "ALTER TABLE oidc_users ADD COLUMN disabled_at DATETIME",
            m: "run",
          });
        }
        if (!names.has("created_by")) {
          statements.push({
            s: "ALTER TABLE oidc_users ADD COLUMN created_by TEXT",
            m: "run",
          });
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
            {
              s: "ALTER TABLE team_members_v2 RENAME TO team_members",
              m: "run",
            },
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
        statements.push({
          s: "UPDATE api_keys SET revoked_at = CURRENT_TIMESTAMP WHERE revoked_at IS NULL",
          m: "run",
        });
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
  {
    version: "015_typed_domain_events",
    async apply() {
      await db.exec(`
        CREATE TABLE IF NOT EXISTS domain_events (
          id TEXT PRIMARY KEY,
          team_id TEXT NOT NULL REFERENCES teams(id) ON DELETE CASCADE,
          type TEXT NOT NULL,
          schema_version INTEGER NOT NULL CHECK (schema_version > 0),
          source TEXT NOT NULL,
          occurred_at DATETIME NOT NULL,
          recorded_at DATETIME NOT NULL,
          correlation_id TEXT,
          causation_id TEXT,
          idempotency_key TEXT,
          data_json TEXT NOT NULL
        );
        CREATE UNIQUE INDEX IF NOT EXISTS idx_domain_events_idempotency
          ON domain_events(team_id, idempotency_key) WHERE idempotency_key IS NOT NULL;
        CREATE INDEX IF NOT EXISTS idx_domain_events_team_recorded
          ON domain_events(team_id, recorded_at DESC, id DESC);
      `);
    },
  },
  {
    version: "016_domain_event_deliveries",
    async apply() {
      await db.exec(`
        CREATE UNIQUE INDEX IF NOT EXISTS idx_domain_events_team_id
          ON domain_events(team_id, id);
        CREATE UNIQUE INDEX IF NOT EXISTS idx_workflows_team_id
          ON workflows(team_id, id);
        CREATE TABLE IF NOT EXISTS domain_event_subscriptions (
          id TEXT PRIMARY KEY,
          team_id TEXT NOT NULL REFERENCES teams(id) ON DELETE CASCADE,
          workflow_id TEXT NOT NULL,
          workflow_revision INTEGER NOT NULL CHECK (workflow_revision > 0),
          event_type TEXT NOT NULL,
          enabled INTEGER NOT NULL DEFAULT 1 CHECK (enabled IN (0, 1)),
          created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
          UNIQUE(team_id, id),
          FOREIGN KEY (team_id, workflow_id) REFERENCES workflows(team_id, id) ON DELETE CASCADE
        );
        CREATE INDEX IF NOT EXISTS idx_domain_event_subscriptions_match
          ON domain_event_subscriptions(team_id, event_type, enabled, created_at);
        CREATE TABLE IF NOT EXISTS domain_event_deliveries (
          id TEXT PRIMARY KEY,
          team_id TEXT NOT NULL REFERENCES teams(id) ON DELETE CASCADE,
          event_id TEXT NOT NULL REFERENCES domain_events(id) ON DELETE CASCADE,
          subscription_id TEXT NOT NULL,
          status TEXT NOT NULL DEFAULT 'pending'
            CHECK (status IN ('pending', 'claimed', 'admitted', 'filtered', 'failed')),
          attempt_count INTEGER NOT NULL DEFAULT 0 CHECK (attempt_count >= 0),
          lease_until DATETIME,
          job_ids_json TEXT NOT NULL DEFAULT '[]',
          last_error TEXT,
          created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
          updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
          UNIQUE(event_id, subscription_id),
          FOREIGN KEY (team_id, event_id) REFERENCES domain_events(team_id, id) ON DELETE CASCADE,
          FOREIGN KEY (team_id, subscription_id) REFERENCES domain_event_subscriptions(team_id, id) ON DELETE CASCADE
        );
        CREATE INDEX IF NOT EXISTS idx_domain_event_deliveries_claim
          ON domain_event_deliveries(team_id, status, lease_until, created_at);
        CREATE INDEX IF NOT EXISTS idx_domain_event_deliveries_history
          ON domain_event_deliveries(team_id, created_at DESC, id DESC);
      `);
    },
  },
  {
    version: "017_domain_event_delivery_fences",
    async apply() {
      const columns = await db.all("PRAGMA table_info(domain_event_subscriptions)");
      if (!columns.some((column: any) => column.name === "high_water_event_rowid")) {
        await db.exec(
          "ALTER TABLE domain_event_subscriptions ADD COLUMN high_water_event_rowid INTEGER NOT NULL DEFAULT 0",
        );
      }
      await db.exec("CREATE INDEX IF NOT EXISTS idx_domain_events_rowid_team_type ON domain_events(team_id, type)");
    },
  },
  {
    version: "018_domain_event_subscription_identity",
    async apply() {
      const duplicates = await db.all(
        `SELECT team_id, workflow_id, workflow_revision, event_type
         FROM domain_event_subscriptions
         GROUP BY team_id, workflow_id, workflow_revision, event_type
         HAVING COUNT(*) > 1`,
      );
      if (duplicates.length) {
        throw new Error(
          `Cannot enforce domain event subscription identity: ${duplicates.length} duplicate identity group(s) exist; inspect and reconcile subscriptions/deliveries before retrying migration`,
        );
      }
      await db.exec(`
        CREATE UNIQUE INDEX IF NOT EXISTS idx_domain_event_subscription_identity
          ON domain_event_subscriptions(team_id, workflow_id, workflow_revision, event_type);
      `);
    },
  },
  {
    version: "019_durable_channel_history",
    async apply() {
      await db.exec(`
        CREATE TABLE IF NOT EXISTS channels (
          id TEXT NOT NULL,
          team_id TEXT NOT NULL REFERENCES teams(id) ON DELETE CASCADE,
          name TEXT NOT NULL,
          created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
          PRIMARY KEY (team_id, id),
          UNIQUE (team_id, name)
        );
        CREATE TABLE IF NOT EXISTS channel_messages (
          id TEXT PRIMARY KEY,
          team_id TEXT NOT NULL,
          channel_id TEXT NOT NULL,
          author TEXT NOT NULL,
          body_json TEXT NOT NULL CHECK (json_valid(body_json)),
          caused_by_event_id TEXT,
          caused_by_job_id INTEGER,
          created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
          FOREIGN KEY (team_id, channel_id) REFERENCES channels(team_id, id) ON DELETE CASCADE
        );
        CREATE INDEX IF NOT EXISTS idx_channel_messages_history
          ON channel_messages(team_id, channel_id);
        CREATE TRIGGER IF NOT EXISTS channel_messages_immutable_update
          BEFORE UPDATE ON channel_messages BEGIN SELECT RAISE(ABORT, 'channel messages are immutable'); END;
      `);
    },
  },
  {
    version: "020_durable_step_attempts",
    async apply() {
      await db.exec(`
        CREATE TABLE IF NOT EXISTS step_execution_attempts (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          team_id TEXT NOT NULL REFERENCES teams(id) ON DELETE CASCADE,
          job_id INTEGER NOT NULL REFERENCES jobs(id) ON DELETE CASCADE,
          step_id TEXT NOT NULL,
          attempt INTEGER NOT NULL CHECK (attempt > 0),
          status TEXT NOT NULL CHECK (status IN ('success', 'failed', 'cancelled', 'skipped')),
          started_at DATETIME NOT NULL,
          completed_at DATETIME NOT NULL,
          duration_ms INTEGER NOT NULL CHECK (duration_ms >= 0),
          exit_code INTEGER,
          error TEXT,
          log_content TEXT NOT NULL DEFAULT '',
          UNIQUE(job_id, step_id, attempt)
        );
        CREATE INDEX IF NOT EXISTS idx_step_execution_attempts_job
          ON step_execution_attempts(team_id, job_id, step_id, attempt);
      `);
    },
  },
  {
    version: "021_agent_workflow_grants",
    async apply() {
      await db.exec(`
        CREATE TABLE IF NOT EXISTS agent_workflow_grants (
          team_id TEXT NOT NULL REFERENCES teams(id) ON DELETE CASCADE,
          agent_principal_id TEXT NOT NULL,
          workflow_id TEXT NOT NULL,
          granted_by TEXT NOT NULL,
          created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
          PRIMARY KEY (team_id, agent_principal_id, workflow_id),
          FOREIGN KEY (team_id, agent_principal_id) REFERENCES team_members(team_id, subject) ON DELETE CASCADE,
          FOREIGN KEY (team_id, workflow_id) REFERENCES workflows(team_id, id) ON DELETE CASCADE
        );
        CREATE INDEX IF NOT EXISTS idx_agent_workflow_grants_agent
          ON agent_workflow_grants(team_id, agent_principal_id);
      `);
    },
  },
  {
    version: "022_workflow_run_admission",
    async apply() {
      await db.exec(`
        CREATE TABLE IF NOT EXISTS workflow_run_admissions (
          event_id TEXT NOT NULL,
          team_id TEXT NOT NULL,
          workflow_id TEXT NOT NULL,
          revision INTEGER NOT NULL,
          variant_index INTEGER NOT NULL,
          matrix_json TEXT NOT NULL,
          tags_json TEXT NOT NULL,
          status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','claimed','admitted','failed')),
          lease_token TEXT,
          lease_until TEXT,
          job_id INTEGER,
          error_code TEXT,
          updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
          PRIMARY KEY (event_id, variant_index)
        );
        CREATE INDEX IF NOT EXISTS workflow_run_admissions_pending
          ON workflow_run_admissions(status, lease_until, event_id, variant_index);
      `);
    },
  },
  {
    version: "023_workflow_run_admission_retry_schedule",
    async apply() {
      const columns = await db.all("PRAGMA table_info(workflow_run_admissions)");
      if (!columns.some((column: any) => column.name === "retry_after")) {
        await db.run("ALTER TABLE workflow_run_admissions ADD COLUMN retry_after TEXT");
      }
      await db.exec(`
        CREATE INDEX IF NOT EXISTS workflow_run_admissions_retry
          ON workflow_run_admissions(status, retry_after, updated_at, event_id, variant_index);
      `);
    },
  },
  {
    version: "024_step_attempt_start_markers",
    async apply() {
      await db.exec(`
        CREATE TABLE IF NOT EXISTS step_execution_attempt_starts (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          team_id TEXT NOT NULL REFERENCES teams(id) ON DELETE CASCADE,
          job_id INTEGER NOT NULL REFERENCES jobs(id) ON DELETE CASCADE,
          step_id TEXT NOT NULL,
          attempt INTEGER NOT NULL CHECK (attempt > 0),
          started_at DATETIME NOT NULL,
          UNIQUE(job_id, step_id, attempt)
        );
        CREATE INDEX IF NOT EXISTS idx_step_execution_attempt_starts_job
          ON step_execution_attempt_starts(team_id, job_id, step_id, attempt);
        CREATE TRIGGER IF NOT EXISTS step_attempt_starts_immutable_update
          BEFORE UPDATE ON step_execution_attempt_starts
          BEGIN SELECT RAISE(ABORT, 'step attempt start markers are immutable'); END;
      `);
    },
  },
  {
    version: "026_durable_event_sequence",
    async apply() {
      const columns = await db.all("PRAGMA table_info(domain_events)");
      if (!columns.some((column: any) => column.name === "sequence")) {
        await db.exec("ALTER TABLE domain_events ADD COLUMN sequence INTEGER");
      }
      await db.exec(`
        UPDATE domain_events SET sequence = rowid WHERE sequence IS NULL;
        CREATE UNIQUE INDEX IF NOT EXISTS idx_domain_events_sequence ON domain_events(sequence);
        CREATE TRIGGER IF NOT EXISTS trg_domain_events_sequence
        AFTER INSERT ON domain_events WHEN NEW.sequence IS NULL
        BEGIN
          UPDATE domain_events SET sequence = (SELECT COALESCE(MAX(sequence), 0) + 1
            FROM domain_events WHERE id <> NEW.id) WHERE id = NEW.id;
        END;
      `);
      const subscriptionColumns = await db.all("PRAGMA table_info(domain_event_subscriptions)");
      if (!subscriptionColumns.some((column: any) => column.name === "high_water_event_sequence")) {
        await db.exec(
          "ALTER TABLE domain_event_subscriptions ADD COLUMN high_water_event_sequence INTEGER NOT NULL DEFAULT 0",
        );
      }
      await db.exec(`
        UPDATE domain_event_subscriptions
        SET high_water_event_sequence = high_water_event_rowid
        WHERE high_water_event_sequence = 0 AND high_water_event_rowid > 0;
        CREATE INDEX IF NOT EXISTS idx_domain_events_sequence_team_type ON domain_events(team_id, type, sequence);
      `);
    },
  },
  {
    version: "027_channel_event_history_index",
    async apply() {
      await db.exec(`
        CREATE INDEX IF NOT EXISTS idx_domain_events_channel_sequence
          ON domain_events(team_id, json_extract(data_json, '$.channelId'), sequence);
      `);
    },
  },
  {
    version: "028_workflow_run_plan_ready",
    async apply() {
      await db.exec(`
        CREATE TABLE IF NOT EXISTS workflow_run_admission_plans (
          event_id TEXT PRIMARY KEY,
          variant_count INTEGER NOT NULL CHECK (variant_count > 0),
          plan_hash TEXT NOT NULL,
          ready_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
        );
      `);
    },
  },
  {
    version: "029_step_attempt_identity",
    async apply() {
      for (const table of ["step_execution_attempt_starts", "step_execution_attempts"]) {
        const columns = await db.all(`PRAGMA table_info(${table})`);
        if (!columns.length) {
          throw new Error(`Cannot add step attempt identity: ${table} is missing`);
        }
        if (!columns.some((column: any) => column.name === "attempt_id")) {
          await db.run(`ALTER TABLE ${table} ADD COLUMN attempt_id TEXT`);
        }
      }
      await db.exec(`
        CREATE UNIQUE INDEX IF NOT EXISTS idx_step_attempt_start_identity
          ON step_execution_attempt_starts(attempt_id) WHERE attempt_id IS NOT NULL;
        CREATE UNIQUE INDEX IF NOT EXISTS idx_step_attempt_completion_identity
          ON step_execution_attempts(attempt_id) WHERE attempt_id IS NOT NULL;
      `);
    },
  },
  {
    version: "030_domain_event_delivery_invocation_link",
    async apply() {
      const columns = await db.all("PRAGMA table_info(domain_event_deliveries)");
      if (!columns.some((column: any) => column.name === "invocation_id")) {
        await db.exec("ALTER TABLE domain_event_deliveries ADD COLUMN invocation_id TEXT");
      }
      await db.exec(
        "CREATE INDEX IF NOT EXISTS idx_domain_event_deliveries_invocation ON domain_event_deliveries(team_id, invocation_id)",
      );
    },
  },
  {
    version: "031_stream_threads",
    async apply() {
      await db.exec(`
        CREATE TABLE IF NOT EXISTS channel_threads (
          id TEXT NOT NULL,
          team_id TEXT NOT NULL,
          channel_id TEXT NOT NULL,
          title TEXT NOT NULL CHECK(length(trim(title)) BETWEEN 1 AND 160),
          created_by TEXT NOT NULL,
          created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
          updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
          PRIMARY KEY(team_id, id),
          UNIQUE(team_id, channel_id, id),
          FOREIGN KEY(team_id, channel_id) REFERENCES channels(team_id, id) ON DELETE CASCADE
        );
        CREATE INDEX IF NOT EXISTS idx_channel_threads_stream
          ON channel_threads(team_id, channel_id, updated_at DESC, id);
        CREATE TABLE IF NOT EXISTS channel_thread_messages (
          id TEXT NOT NULL,
          team_id TEXT NOT NULL,
          channel_id TEXT NOT NULL,
          thread_id TEXT NOT NULL,
          author TEXT NOT NULL,
          body_json TEXT NOT NULL CHECK(json_valid(body_json)),
          caused_by_event_id TEXT,
          caused_by_job_id INTEGER,
          created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
          PRIMARY KEY(team_id, id),
          FOREIGN KEY(team_id, channel_id, thread_id) REFERENCES channel_threads(team_id, channel_id, id) ON DELETE CASCADE
        );
        CREATE INDEX IF NOT EXISTS idx_channel_thread_messages_history
          ON channel_thread_messages(team_id, channel_id, thread_id, created_at, id);
        CREATE TRIGGER IF NOT EXISTS channel_thread_messages_immutable_update
          BEFORE UPDATE ON channel_thread_messages BEGIN SELECT RAISE(ABORT, 'thread messages are immutable'); END;
        CREATE TRIGGER IF NOT EXISTS channel_thread_messages_touch_thread
          AFTER INSERT ON channel_thread_messages
          BEGIN
            UPDATE channel_threads SET updated_at = CURRENT_TIMESTAMP
             WHERE team_id = NEW.team_id AND channel_id = NEW.channel_id AND id = NEW.thread_id;
          END;
      `);
    },
  },
  {
    version: "032_step_attempt_snapshots",
    async apply() {
      const columns = await db.all("PRAGMA table_info(step_execution_attempts)");
      if (!columns.length) {
        throw new Error("Cannot add step attempt snapshots: step_execution_attempts is missing");
      }
      if (!columns.some((column: any) => column.name === "snapshot_json")) {
        await db.run("ALTER TABLE step_execution_attempts ADD COLUMN snapshot_json TEXT");
      }
    },
  },
  {
    version: "033_stream_event_bindings",
    async apply() {
      await db.exec(`
        CREATE TABLE IF NOT EXISTS stream_event_bindings (
          team_id TEXT NOT NULL,
          stream_id TEXT NOT NULL,
          event_id TEXT NOT NULL,
          created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
          PRIMARY KEY (team_id, stream_id, event_id),
          FOREIGN KEY (team_id, stream_id) REFERENCES channels(team_id, id) ON DELETE CASCADE
        );
        CREATE INDEX IF NOT EXISTS idx_stream_event_bindings_event
          ON stream_event_bindings(team_id, event_id, stream_id);
        INSERT OR IGNORE INTO stream_event_bindings (team_id, stream_id, event_id)
        SELECT e.team_id, json_extract(e.data_json, '$.channelId'), e.id
          FROM domain_events e
          JOIN channels c ON c.team_id = e.team_id AND c.id = json_extract(e.data_json, '$.channelId')
         WHERE json_valid(e.data_json)
           AND json_type(e.data_json, '$.channelId') = 'text';
      `);
    },
  },
  {
    version: "034_stream_event_binding_integrity",
    async apply() {
      await db.exec(`
        CREATE TRIGGER IF NOT EXISTS stream_event_binding_team_guard
          BEFORE INSERT ON stream_event_bindings
          WHEN NOT EXISTS (
            SELECT 1 FROM domain_events
             WHERE domain_events.team_id = NEW.team_id AND domain_events.id = NEW.event_id
          )
          BEGIN SELECT RAISE(ABORT, 'stream event binding must reference an event in the same workspace'); END;
      `);
    },
  },
  {
    version: "035_domain_event_fanout_outcomes",
    async apply() {
      await db.exec(`
        CREATE TABLE IF NOT EXISTS domain_event_fanout_outcomes (
          team_id TEXT NOT NULL,
          event_id TEXT NOT NULL,
          status TEXT NOT NULL CHECK(status IN ('matched', 'repeat', 'unmatched')),
          delivery_count INTEGER NOT NULL DEFAULT 0,
          created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
          updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
          PRIMARY KEY(team_id, event_id),
          FOREIGN KEY(team_id, event_id) REFERENCES domain_events(team_id, id) ON DELETE CASCADE
        );
        CREATE INDEX IF NOT EXISTS idx_domain_event_fanout_outcomes_history
          ON domain_event_fanout_outcomes(team_id, updated_at DESC, event_id);
      `);
    },
  },
  {
    version: "036_workflow_run_admission_outcomes",
    async apply() {
      const columns = await db.all("PRAGMA table_info(workflow_run_admissions)");
      if (!columns.some((column: any) => column.name === "admission_outcome")) {
        await db.exec(`ALTER TABLE workflow_run_admissions ADD COLUMN admission_outcome TEXT
          CHECK (admission_outcome IN ('accepted','rejected','filtered'))`);
      }
      await db.exec(`UPDATE workflow_run_admissions SET admission_outcome = 'accepted'
        WHERE status = 'admitted' AND admission_outcome IS NULL`);
    },
  },
  {
    version: "037_workspace_logos",
    async apply() {
      await db.exec(`CREATE TABLE IF NOT EXISTS workspace_logos (
        team_id TEXT PRIMARY KEY REFERENCES teams(id) ON DELETE CASCADE,
        mime_type TEXT NOT NULL CHECK (mime_type IN ('image/png','image/jpeg','image/webp')),
        data TEXT NOT NULL CHECK (length(data) BETWEEN 4 AND 349528),
        updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
      )`);
    },
  },
  {
    version: "038_yaml_connectors",
    async apply() {
      const incomingColumns = await db.all("PRAGMA table_info(incoming_events)");
      if (incomingColumns.length) {
        if (!incomingColumns.some((column: any) => column.name === "connector_id")) {
          await db.exec("ALTER TABLE incoming_events ADD COLUMN connector_id TEXT");
        }
        if (!incomingColumns.some((column: any) => column.name === "connector_revision")) {
          await db.exec("ALTER TABLE incoming_events ADD COLUMN connector_revision INTEGER");
        }
        if (!incomingColumns.some((column: any) => column.name === "headers_ciphertext")) {
          await db.exec("ALTER TABLE incoming_events ADD COLUMN headers_ciphertext TEXT");
        }
      }
      const replayColumns = await db.all("PRAGMA table_info(incoming_event_replays)");
      if (replayColumns.length) {
        if (!replayColumns.some((column: any) => column.name === "connector_revision")) {
          await db.exec("ALTER TABLE incoming_event_replays ADD COLUMN connector_revision INTEGER");
        }
        if (!replayColumns.some((column: any) => column.name === "normalized_event_id")) {
          await db.exec("ALTER TABLE incoming_event_replays ADD COLUMN normalized_event_id TEXT");
        }
      }
      await db.exec(`
        CREATE TABLE IF NOT EXISTS connectors (
          team_id TEXT NOT NULL REFERENCES teams(id) ON DELETE CASCADE,
          connector_id TEXT NOT NULL CHECK (connector_id GLOB '[a-z0-9]*' AND connector_id NOT GLOB '*[^a-z0-9-]*'),
          name TEXT NOT NULL CHECK (length(trim(name)) BETWEEN 1 AND 200),
          source_yaml TEXT NOT NULL CHECK (length(source_yaml) BETWEEN 1 AND 256000),
          revision INTEGER NOT NULL CHECK (revision > 0),
          webhook_token_hash TEXT UNIQUE,
          enabled INTEGER NOT NULL DEFAULT 1 CHECK (enabled IN (0,1)),
          created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
          updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
          PRIMARY KEY (team_id, connector_id)
        );
        CREATE TABLE IF NOT EXISTS connector_revisions (
          team_id TEXT NOT NULL,
          connector_id TEXT NOT NULL,
          revision INTEGER NOT NULL CHECK (revision > 0),
          source_yaml TEXT NOT NULL,
          created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
          PRIMARY KEY (team_id, connector_id, revision),
          FOREIGN KEY (team_id, connector_id) REFERENCES connectors(team_id, connector_id) ON DELETE CASCADE
        );
        CREATE INDEX IF NOT EXISTS connectors_webhook_token ON connectors(webhook_token_hash) WHERE webhook_token_hash IS NOT NULL;
        CREATE TRIGGER IF NOT EXISTS connectors_revision_after_insert
          AFTER INSERT ON connectors
          BEGIN
            INSERT INTO connector_revisions (team_id, connector_id, revision, source_yaml)
            VALUES (NEW.team_id, NEW.connector_id, NEW.revision, NEW.source_yaml);
          END;
        CREATE TRIGGER IF NOT EXISTS connectors_revision_after_update
          AFTER UPDATE OF source_yaml, revision ON connectors
          WHEN NEW.revision <> OLD.revision OR NEW.source_yaml <> OLD.source_yaml
          BEGIN
            INSERT INTO connector_revisions (team_id, connector_id, revision, source_yaml)
            VALUES (NEW.team_id, NEW.connector_id, NEW.revision, NEW.source_yaml);
          END;
      `);
    },
  },
  {
    version: "039_connector_drafts",
    async apply() {
      const columns = await db.all("PRAGMA table_info(connectors)");
      if (!columns.some((column: any) => column.name === "draft_yaml")) {
        await db.exec("ALTER TABLE connectors ADD COLUMN draft_yaml TEXT");
      }
      if (!columns.some((column: any) => column.name === "draft_name")) {
        await db.exec("ALTER TABLE connectors ADD COLUMN draft_name TEXT");
      }
      if (!columns.some((column: any) => column.name === "published")) {
        await db.exec(
          "ALTER TABLE connectors ADD COLUMN published INTEGER NOT NULL DEFAULT 1 CHECK (published IN (0,1))",
        );
      }
    },
  },
  {
    version: "040_connector_webhook_signing_secret",
    async apply() {
      const columns = await db.all("PRAGMA table_info(connectors)");
      if (!columns.some((column: any) => column.name === "signing_secret_ciphertext")) {
        await db.exec("ALTER TABLE connectors ADD COLUMN signing_secret_ciphertext TEXT");
      }
    },
  },
  {
    version: "041_connector_template_registry",
    async apply() {
      const connectorColumns = await db.all("PRAGMA table_info(connectors)");
      for (const [name, type] of [
        ["template_namespace", "TEXT"],
        ["template_slug", "TEXT"],
        ["template_version", "INTEGER"],
      ]) {
        if (!connectorColumns.some((column: any) => column.name === name)) {
          await db.exec(`ALTER TABLE connectors ADD COLUMN ${name} ${type}`);
        }
      }
      await db.exec(`
        CREATE TABLE IF NOT EXISTS connector_template_publishers (
          owner_subject TEXT PRIMARY KEY,
          namespace TEXT NOT NULL UNIQUE
        );
        CREATE TABLE IF NOT EXISTS connector_template_versions (
          namespace TEXT NOT NULL,
          slug TEXT NOT NULL,
          version INTEGER NOT NULL CHECK (version > 0),
          name TEXT NOT NULL,
          description TEXT NOT NULL,
          source_yaml TEXT NOT NULL,
          publisher_subject TEXT NOT NULL,
          created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
          PRIMARY KEY (namespace, slug, version),
          FOREIGN KEY (publisher_subject) REFERENCES connector_template_publishers(owner_subject)
        );
      `);
      await db.run(`INSERT OR IGNORE INTO connector_template_publishers(owner_subject, namespace) VALUES (?, ?)`, [
        "system:connector-templates",
        GITHUB_PUSH_TEMPLATE.namespace,
      ]);
      await db.run(
        `INSERT OR IGNORE INTO connector_template_versions
          (namespace, slug, version, name, description, source_yaml, publisher_subject)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
        [
          GITHUB_PUSH_TEMPLATE.namespace,
          GITHUB_PUSH_TEMPLATE.slug,
          GITHUB_PUSH_TEMPLATE.version,
          GITHUB_PUSH_TEMPLATE.name,
          GITHUB_PUSH_TEMPLATE.description,
          GITHUB_PUSH_TEMPLATE.sourceYaml,
          "system:connector-templates",
        ],
      );
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
