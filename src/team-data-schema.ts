import db from "./db-client.js";

async function ensureColumn(table: string, column: string, definition: string): Promise<void> {
  const columns = await db.all(`PRAGMA table_info(${table})`);
  if (columns.length && !columns.some((item: any) => item.name === column)) {
    const row = await db.get(`SELECT 1 AS present FROM ${table} LIMIT 1`);
    if (row) {
      throw new Error(`Cannot add ${table}.${column} to populated data without an explicit workspace assignment`);
    }
    await db.run(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`);
  }
}

/** Adds tenant ownership without depending on initialization order (queue precedes workflows). */
export async function ensureTeamDataSchema(): Promise<void> {
  await ensureColumn("workflows", "team_id", "TEXT NOT NULL");
  await ensureColumn("jobs", "team_id", "TEXT NOT NULL REFERENCES teams(id) ON DELETE RESTRICT");
  const workflowColumns = await db.all("PRAGMA table_info(workflows)");
  const jobColumns = await db.all("PRAGMA table_info(jobs)");
  await db.exec(`
    CREATE TABLE IF NOT EXISTS team_secrets (
      team_id TEXT NOT NULL REFERENCES teams(id) ON DELETE CASCADE, name TEXT NOT NULL, ciphertext TEXT NOT NULL,
      encoding TEXT NOT NULL DEFAULT 'utf8', created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      updated_at DATETIME DEFAULT CURRENT_TIMESTAMP, PRIMARY KEY(team_id, name)
    );
    CREATE INDEX IF NOT EXISTS idx_team_secrets_team ON team_secrets(team_id, name);
  `);
  if (workflowColumns.some((item: any) => item.name === "team_id")) {
    await db.exec("CREATE INDEX IF NOT EXISTS idx_workflows_team ON workflows(team_id, id)");
  }
  if (jobColumns.some((item: any) => item.name === "team_id")) {
    await db.exec("CREATE INDEX IF NOT EXISTS idx_jobs_team ON jobs(team_id, id)");
  }
  // Legacy jobs belong to the team that owns their workflow.
  if (
    workflowColumns.some((item: any) => item.name === "team_id") &&
    jobColumns.some((item: any) => item.name === "team_id")
  ) {
    const unscopedJob = await db.get(
      `SELECT jobs.id FROM jobs
       LEFT JOIN workflows ON workflows.id = jobs.workflow_id
       LEFT JOIN teams ON teams.id = jobs.team_id
       WHERE workflows.id IS NULL OR teams.id IS NULL OR jobs.team_id != workflows.team_id
       LIMIT 1`,
    );
    if (unscopedJob) {
      throw new Error(
        `Job ${unscopedJob.id} has no valid workspace owner; assign it explicitly before starting the runner`,
      );
    }
  }
}
