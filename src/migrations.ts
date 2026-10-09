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
    if (applied.has(migration.version)) continue;
    await migration.apply();
    await db.run("INSERT INTO schema_migrations (version) VALUES (?)", [migration.version]);
  }
}
