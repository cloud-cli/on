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
