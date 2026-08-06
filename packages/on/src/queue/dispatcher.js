import db from '../db-client.js';
export class QueueManager {
    workerId;
    constructor(workerId) {
        this.workerId = workerId;
    }
    /**
     * Initializes the database schema.
     */
    async init() {
        await db.run(`
      CREATE TABLE IF NOT EXISTS jobs (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        workflow_id TEXT NOT NULL,
        payload TEXT NOT NULL,
        status TEXT NOT NULL DEFAULT 'pending',
        concurrency_key TEXT,
        worker_id TEXT,
        report TEXT, -- Stores WorkflowExecutionReport JSON
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
      )
    `);
        await this.clearStaleJobs();
    }
    /**
     * Enqueues a new job into the database.
     * Includes simple GitHub-style concurrency cancellation.
     */
    async enqueue(workflowId, payload, concurrencyKey) {
        // If a concurrency key is provided, cancel existing pending/running jobs in that group
        if (concurrencyKey) {
            await db.run(`
        UPDATE jobs
        SET status = 'cancelling'
        WHERE concurrency_key = ? AND status IN ('pending', 'running');
      `, [concurrencyKey]);
        }
        const res = await db.run(`
      INSERT INTO jobs (workflow_id, concurrency_key, payload)
      VALUES (?, ?, ?);
    `, [workflowId, concurrencyKey || '', JSON.stringify(payload)]);
        return res;
    }
    /**
     * ATOMICALY claims the oldest pending job.
     * Requires SQLite >= 3.35 for the RETURNING clause.
     */
    async claimNextJob() {
        // This query is completely immune to HTTP/Network race conditions.
        // It locks the row, updates it, and returns the data in one transaction.
        const result = await db.get(`
      UPDATE jobs
      SET
        status = 'running',
        worker_id = ?,
        started_at = CURRENT_TIMESTAMP
      WHERE id = (
        SELECT id FROM jobs
        WHERE status = 'pending'
        ORDER BY created_at ASC
        LIMIT 1
      )
      RETURNING *;
    `, [this.workerId]);
        return result ? result : null;
    }
    /**
     * Marks a job as completed or failed
     */
    async finishJob(jobId, status) {
        await db.run(`
      UPDATE jobs
      SET status = ?, finished_at = CURRENT_TIMESTAMP
      WHERE id = ?;
    `, [status, jobId]);
    }
    /**
     * Checks if the current job has been marked for cancellation by another event
     */
    async isCancelled(jobId) {
        const job = await db.get(`SELECT status FROM jobs WHERE id = ?;`, [jobId]);
        return job?.status === 'cancelling';
    }
    async clearStaleJobs() {
        return await db.run(`UPDATE jobs SET status = 'pending', worker_id = NULL WHERE status = 'running' AND started_at < datetime('now', '-1 hour');`);
    }
    /**
     * Save complete execution report JSON to DB
     */
    async saveReport(jobId, report) {
        await db.run(`UPDATE jobs SET report = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?`, [
            JSON.stringify(report),
            jobId,
        ]);
    }
    /**
     * Fetch job details + report by ID
     */
    async getJob(jobId) {
        return db.get(`SELECT * FROM jobs WHERE id = ?`, [jobId]);
    }
    /**
     * List recent jobs for dashboard status monitoring
     */
    async listJobs(limit = 50) {
        return db.all(`SELECT id, workflow_id, status, concurrency_key, worker_id, created_at, updated_at, report
       FROM jobs
       ORDER BY id DESC
       LIMIT ?`, [limit]);
    }
}
//# sourceMappingURL=dispatcher.js.map