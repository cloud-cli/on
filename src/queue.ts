import db from './db-client.js';
import { WorkflowExecutionReport, JobPayload, JobRecord, JobStatus } from './types.js';
import { timestampLogLines } from './timestamped-log.js';
import { FileStorage } from './file-storage.js';

export class QueueManager {
  private readonly fileStorage = new FileStorage();

  constructor(private workerId: string) {}

  async init() {
    await this.createTables();
    await this.clearStaleJobs();
  }

  /**
   * Enqueues a new job into the database.
   * Includes simple GitHub-style concurrency cancellation.
   */
  async enqueue(workflowId: string, workflowRevision: number, payload: JobPayload, requiredTags: string[] = [], concurrencyKey?: string) {
    // If a concurrency key is provided, cancel existing pending/running jobs in that group
    if (concurrencyKey) {
      await db.run(
        `UPDATE jobs SET status = 'cancelled' WHERE concurrency_key = ? AND status IN ('pending', 'running');`,
        [concurrencyKey],
      );
    }

    const res = await db.run(`INSERT INTO jobs (workflow_id, workflow_revision, required_tags, concurrency_key, payload) VALUES (?, ?, ?, ?, ?);`, [
      workflowId,
      workflowRevision,
      JSON.stringify(requiredTags),
      concurrencyKey || '',
      JSON.stringify(payload),
    ]);

    return Number(res?.lastInsertRowid ?? res?.id ?? 0);
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
            FROM json_each(COALESCE(jobs.required_tags, '[]')) AS required_tag
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
       SET status = CASE WHEN status = 'cancelled' THEN 'cancelled' ELSE ? END,
           report = ?, updated_at = CURRENT_TIMESTAMP, finished_at = CURRENT_TIMESTAMP
       WHERE id = ?;`,
      [status, JSON.stringify(report), jobId],
    );
  }

  async cancelJob(jobId: string | number): Promise<'cancelled' | 'not_found' | 'not_active'> {
    const job = await this.getJob(jobId);
    if (!job) return 'not_found';
    if (job.status !== 'pending' && job.status !== 'running') return 'not_active';

    await db.run(
      `UPDATE jobs SET status = 'cancelled', updated_at = CURRENT_TIMESTAMP, finished_at = CURRENT_TIMESTAMP
       WHERE id = ? AND status IN ('pending', 'running');`,
      [jobId],
    );
    return (await this.getJob(jobId))?.status === 'cancelled' ? 'cancelled' : 'not_active';
  }

  async restartJob(jobId: string | number, manualInputs: Record<string, unknown> = {}) {
    const job = await this.getJob(jobId);

    if (!job) return;

    if (job.status === 'running') {
      await db.run(`UPDATE jobs SET status = 'cancelled', finished_at = CURRENT_TIMESTAMP WHERE id = ?;`, [jobId]);
    }

    const activeWorkflow = await db.get('SELECT active_revision FROM workflows WHERE id = ?', [job.workflow_id]);
    const activeRevision = Number(activeWorkflow?.active_revision);
    if (!Number.isSafeInteger(activeRevision) || activeRevision < 1) {
      throw new Error(`Workflow ${job.workflow_id} has no active revision`);
    }
    const payload = job.payload ? typeof job.payload === 'string' ? JSON.parse(job.payload) : job.payload : { inputs: {} };
    payload.inputs = { ...(payload.inputs || {}), ...manualInputs };

    const newJob = await db.get(
      `INSERT INTO jobs (
         parentId, workflow_id, workflow_revision, required_tags, concurrency_key, payload,
         status, worker_id, report, started_at, finished_at
       )
       SELECT id, workflow_id, ?, required_tags, concurrency_key, ?,
              'pending', NULL, NULL, NULL, NULL
       FROM jobs
       WHERE id = ?
       RETURNING *`,
      [activeRevision, JSON.stringify(payload), jobId],
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
        workflow_revision INTEGER NOT NULL,
        required_tags TEXT NOT NULL DEFAULT '[]',
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

      CREATE TABLE IF NOT EXISTS stored_files (
        kind TEXT NOT NULL,
        owner_key TEXT NOT NULL,
        file_path TEXT NOT NULL,
        content TEXT NOT NULL,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        PRIMARY KEY (kind, owner_key, file_path)
      );
      CREATE INDEX IF NOT EXISTS idx_stored_files_owner ON stored_files(kind, owner_key);

      CREATE TABLE IF NOT EXISTS worker_presence (
        worker_id TEXT PRIMARY KEY,
        version TEXT NOT NULL,
        tags TEXT NOT NULL DEFAULT '[]',
        concurrency INTEGER NOT NULL DEFAULT 0,
        active_jobs INTEGER NOT NULL DEFAULT 0,
        last_seen DATETIME DEFAULT CURRENT_TIMESTAMP
      );
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
  async listJobs(limit = 50, afterId?: number, beforeId?: number, filter?: string, workflowId?: string): Promise<any[]> {
    const conditions: string[] = [];
    const values: Array<number | string> = [];

    if (afterId !== undefined) {
      conditions.push('id > ?');
      values.push(afterId);
    }
    if (beforeId !== undefined) {
      conditions.push('id < ?');
      values.push(beforeId);
    }
    if (filter) {
      const separator = filter.indexOf(':');
      if (separator > 0) {
        const field = filter.slice(0, separator).trim();
        const pattern = filter.slice(separator + 1).trim();
        if (!/^[A-Za-z0-9_-]+$/.test(field) || !pattern) throw new Error('Invalid job filter');
        conditions.push("json_extract(payload, '$.inputs.' || ?) GLOB ?");
        values.push(field, pattern);
      } else {
        conditions.push('LOWER(payload) LIKE LOWER(?)');
        values.push(`%${filter}%`);
      }
    }
    if (workflowId) {
      conditions.push('workflow_id = ?');
      values.push(workflowId);
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
      [jobId, stepId, timestampLogLines(logContent)],
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

  async saveStoredFiles(kind: 'artifact' | 'cache', ownerKey: string, files: Array<{ path: string; content: string }>): Promise<void> {
    if (this.fileStorage.enabled) return this.fileStorage.save(`${kind}/${ownerKey}`, files);
    for (const file of files) {
      await db.run(
        `INSERT INTO stored_files (kind, owner_key, file_path, content) VALUES (?, ?, ?, ?)
         ON CONFLICT(kind, owner_key, file_path) DO UPDATE SET content = excluded.content, created_at = CURRENT_TIMESTAMP`,
        [kind, ownerKey, file.path, file.content],
      );
    }
  }

  async getStoredFiles(kind: 'artifact' | 'cache', ownerKey: string): Promise<Array<{ path: string; content: string }>> {
    if (this.fileStorage.enabled) return this.fileStorage.load(`${kind}/${ownerKey}`);
    return db.all('SELECT file_path AS path, content FROM stored_files WHERE kind = ? AND owner_key = ?', [kind, ownerKey]);
  }

  async updateWorkerPresence(worker: { id: string; version: string; tags: string[]; concurrency: number; activeJobs: number }): Promise<void> {
    await db.run(
      `INSERT INTO worker_presence (worker_id, version, tags, concurrency, active_jobs, last_seen)
       VALUES (?, ?, ?, ?, ?, CURRENT_TIMESTAMP)
       ON CONFLICT(worker_id) DO UPDATE SET version = excluded.version, tags = excluded.tags,
       concurrency = excluded.concurrency, active_jobs = excluded.active_jobs, last_seen = CURRENT_TIMESTAMP`,
      [worker.id, worker.version, JSON.stringify(worker.tags), worker.concurrency, worker.activeJobs],
    );
  }

  async listWorkerPresence(): Promise<any[]> {
    const rows = await db.all('SELECT worker_id, version, tags, concurrency, active_jobs, last_seen FROM worker_presence ORDER BY worker_id');
    return rows.map((row: any) => ({
      workerId: row.worker_id,
      version: row.version,
      tags: JSON.parse(row.tags || '[]'),
      concurrency: row.concurrency,
      activeJobs: row.active_jobs,
      lastSeen: row.last_seen,
      online: Date.now() - Date.parse(`${row.last_seen}Z`) < 45_000,
    }));
  }

  async saveAiRequest(jobId: string | number, workflowUrl: string, request: unknown): Promise<void> {
    await db.run('INSERT INTO ai_requests (job_id, workflow_url, request_json) VALUES (?, ?, ?)', [jobId, workflowUrl, JSON.stringify(request)]);
  }
}
