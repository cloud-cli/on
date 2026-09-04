import db from './db-client.js';
import { WorkflowExecutionReport, JobPayload, JobRecord, JobStatus } from './types.js';

export class QueueManager {
  constructor(private workerId: string) {}

  async init() {
    await this.createTables();
    await this.clearStaleJobs();
  }

  /**
   * Enqueues a new job into the database.
   * Includes simple GitHub-style concurrency cancellation.
   */
  async enqueue(workflowId: string, payload: JobPayload, concurrencyKey?: string) {
    // If a concurrency key is provided, cancel existing pending/running jobs in that group
    if (concurrencyKey) {
      await db.run(
        `UPDATE jobs SET status = 'cancelled' WHERE concurrency_key = ? AND status IN ('pending', 'running');`,
        [concurrencyKey],
      );
    }

    const res = await db.run(`INSERT INTO jobs (workflow_id, concurrency_key, payload) VALUES (?, ?, ?);`, [
      workflowId,
      concurrencyKey || '',
      JSON.stringify(payload),
    ]);

    return res;
  }

  /**
   * Atomically claims the oldest pending job compatible with this worker.
   * Requires SQLite >= 3.35 for the RETURNING clause.
   */
  async claimNextJob(workerTags: string[] = []): Promise<JobRecord | null> {
    // This query is completely immune to HTTP/Network race conditions.
    // It locks the row, updates it, and returns the data in one transaction.
    let result = await db.get(
      `
      UPDATE jobs
      SET
        status = 'running',
        worker_id = ?,
        started_at = CURRENT_TIMESTAMP
      WHERE id = (
        SELECT id FROM jobs
        WHERE status = 'pending'
          AND NOT EXISTS (
            SELECT 1
            FROM json_each(COALESCE(json_extract(jobs.payload, '$.tags'), '[]')) AS required_tag
            WHERE required_tag.value NOT IN (SELECT value FROM json_each(?))
          )
        ORDER BY created_at ASC
        LIMIT 1
      )
      RETURNING *;
    `,
      [this.workerId, JSON.stringify(workerTags)],
    );

    return result ? (result as JobRecord) : null;
  }

  async releaseJob(jobId: string | number): Promise<void> {
    await db.run(
      `UPDATE jobs SET status = 'pending', worker_id = NULL, started_at = NULL WHERE id = ? AND status = 'running';`,
      [jobId],
    );
  }

  /**
   * Marks a job as completed or failed
   */
  async finishJob(jobId: string | number, status: JobStatus) {
    await db.run(`UPDATE jobs SET status = ?, finished_at = CURRENT_TIMESTAMP WHERE id = ?;`, [status, jobId]);
  }

  async completeJob(jobId: string | number, status: JobStatus, report: WorkflowExecutionReport): Promise<void> {
    await db.run(
      `UPDATE jobs
       SET status = ?, report = ?, updated_at = CURRENT_TIMESTAMP, finished_at = CURRENT_TIMESTAMP
       WHERE id = ?;`,
      [status, JSON.stringify(report), jobId],
    );
  }

  async restartJob(jobId: string | number) {
    const job = await this.getJob(jobId);

    if (!job) return;

    if (job.status === 'running') {
      await db.run(`UPDATE jobs SET status = 'cancelled', finished_at = CURRENT_TIMESTAMP WHERE id = ?;`, [jobId]);
    }

    const newJob = await db.get(
      `INSERT INTO jobs (parentId, workflow_id, concurrency_key, payload) SELECT id, workflow_id, concurrency_key, payload FROM jobs WHERE id = ? RETURNING *`,
      [jobId],
    );

    return newJob.id;
  }

  /**
   * Checks if the current job has been marked for cancellation by another event
   */
  async isCancelled(jobId: string | number): Promise<boolean> {
    const job = (await db.get(`SELECT status FROM jobs WHERE id = ?;`, [+jobId])) as { status: JobStatus } | null;
    return job?.status === 'cancelled';
  }

  async clearStaleJobs() {
    return await db.run(
      `UPDATE jobs SET status = 'pending', worker_id = NULL WHERE status = 'running' AND started_at < datetime('now', '-1 hour');`,
    );
  }

  async createTables() {
    await db.exec(`
      CREATE TABLE IF NOT EXISTS jobs (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        parentId INTEGER,
        workflow_id TEXT NOT NULL,
        payload TEXT NOT NULL,
        status TEXT NOT NULL DEFAULT 'pending',
        concurrency_key TEXT,
        worker_id TEXT,
        report TEXT,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        started_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        finished_at DATETIME DEFAULT CURRENT_TIMESTAMP
      );

      CREATE TABLE IF NOT EXISTS step_logs (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        job_id INTEGER NOT NULL,
        step_id TEXT NOT NULL,
        log_content TEXT NOT NULL,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        FOREIGN KEY(job_id) REFERENCES jobs(id) ON DELETE CASCADE
      );

      CREATE INDEX IF NOT EXISTS idx_step_logs_job ON step_logs(job_id);

      DELETE FROM step_logs
      WHERE id NOT IN (
        SELECT MAX(id) FROM step_logs GROUP BY job_id, step_id
      );
      CREATE UNIQUE INDEX IF NOT EXISTS idx_step_logs_job_step ON step_logs(job_id, step_id);
    `);
  }

  /**
   * Fetch job details + report by ID
   */
  async getJob(jobId: string | number): Promise<any> {
    return db.get(`SELECT * FROM jobs WHERE id = ?`, [jobId]);
  }

  /**
   * List recent jobs for dashboard status monitoring
   */
  async listJobs(limit = 50, afterId?: number, beforeId?: number): Promise<any[]> {
    const conditions: string[] = [];
    const values: number[] = [];

    if (afterId !== undefined) {
      conditions.push('id > ?');
      values.push(afterId);
    }
    if (beforeId !== undefined) {
      conditions.push('id < ?');
      values.push(beforeId);
    }

    const where = conditions.length ? ` WHERE ${conditions.join(' AND ')}` : '';
    return db.all(`SELECT * FROM jobs${where} ORDER BY id DESC LIMIT ?;`, [...values, limit]);
  }

  /**
   * Save lightweight summary report (NO heavy logs in this JSON!)
   */
  async saveReport(jobId: string | number, report: WorkflowExecutionReport): Promise<void> {
    await db.run(`UPDATE jobs SET report = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?`, [
      JSON.stringify(report),
      jobId,
    ]);
  }

  /** Save or replace the durable log snapshot for a step. */
  async saveStepLog(jobId: string | number, stepId: string, logContent: string): Promise<void> {
    await db.run(
      `INSERT INTO step_logs (job_id, step_id, log_content) VALUES (?, ?, ?)
       ON CONFLICT(job_id, step_id) DO UPDATE SET
         log_content = excluded.log_content,
         created_at = CURRENT_TIMESTAMP`,
      [jobId, stepId, logContent],
    );
  }

  /**
   * Retrieve all step logs for a specific job (called ON-DEMAND by /runs/:jobId)
   */
  async getJobLogs(jobId: string | number): Promise<Record<string, string>> {
    const rows = await db.all(`SELECT step_id, log_content FROM step_logs WHERE job_id = ?`, [jobId]);

    const logMap: Record<string, string> = {};
    for (const row of rows) {
      logMap[row.step_id] = row.log_content;
    }
    return logMap;
  }
}
