import db from './db-client.js';

type Migration = {
  version: string;
  apply: () => Promise<void>;
};

const migrations: Migration[] = [
  {
    version: '001_add_workflow_enabled',
    async apply() {
      const columns = await db.all('PRAGMA table_info(workflows)');
      if (!columns.some((column: any) => column.name === 'enabled')) {
        await db.run('ALTER TABLE workflows ADD COLUMN enabled INTEGER NOT NULL DEFAULT 1');
      }
    },
  },
  {
    version: '002_add_push_subscriptions',
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
    version: '003_add_push_delivery_history',
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
    version: '004_add_ai_requests',
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
];

export async function runMigrations(): Promise<void> {
  await db.exec(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      version TEXT PRIMARY KEY,
      applied_at DATETIME DEFAULT CURRENT_TIMESTAMP
    )
  `);

  const applied = new Set((await db.all('SELECT version FROM schema_migrations')).map((row: any) => row.version));
  for (const migration of migrations) {
    if (applied.has(migration.version)) continue;
    await migration.apply();
    await db.run('INSERT INTO schema_migrations (version) VALUES (?)', [migration.version]);
  }
}
