import db from "./db-client.js";

type Migration = {
  version: string;
  apply: () => Promise<void>;
};

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
        INSERT OR IGNORE INTO teams (id, name, webhook_token) VALUES ('default', 'Default', lower(hex(randomblob(32))));
        INSERT OR IGNORE INTO team_members (team_id, subject, role)
          SELECT 'default', subject, CASE WHEN role = 'admin' THEN 'admin' ELSE 'member' END FROM oidc_users;
      `);
    },
  },
  {
    version: "006_scope_push_subscriptions_to_teams",
    async apply() {
      await db.exec(`
        CREATE TABLE IF NOT EXISTS team_push_subscriptions (
          team_id TEXT NOT NULL DEFAULT 'default', endpoint TEXT NOT NULL, p256dh TEXT NOT NULL, auth TEXT NOT NULL,
          created_at DATETIME DEFAULT CURRENT_TIMESTAMP, PRIMARY KEY(team_id, endpoint)
        );
        INSERT OR IGNORE INTO team_push_subscriptions (team_id, endpoint, p256dh, auth, created_at)
          SELECT 'default', endpoint, p256dh, auth, created_at FROM push_subscriptions;
        CREATE INDEX IF NOT EXISTS idx_team_push_subscriptions_team ON team_push_subscriptions(team_id);
      `);
    },
  },
  {
    version: "007_scope_api_keys_to_teams",
    async apply() {
      const tables = await db.all("PRAGMA table_info(api_keys)");
      if (tables.length && !tables.some((column: any) => column.name === "team_id")) {
        await db.run("ALTER TABLE api_keys ADD COLUMN team_id TEXT NOT NULL DEFAULT 'default'");
      }
    },
  },
  {
    version: "008_workflows_team_foreign_key",
    async apply() {
      // teams is established by 005. Add ownership before checking it so legacy rows
      // receive the existing default owner, then refuse to hide any invalid ownership.
      const columns = await db.all("PRAGMA table_info(workflows)");
      if (!columns.some((column: any) => column.name === "team_id")) {
        await db.run("ALTER TABLE workflows ADD COLUMN team_id TEXT NOT NULL DEFAULT 'default'");
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
