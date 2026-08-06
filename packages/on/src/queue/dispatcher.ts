import db from '../db-client.js';

export interface JobRecord {
  id: number;
  workflow_id: string;
  concurrency_key: string | null;
  status: 'pending' | 'running' | 'success' | 'failed' | 'cancelling';
  worker_id: string | null;
  payload: string; // JSON string of the Job Context/Steps
  created_at: string;
}

export class QueueManager {
  constructor(private workerId: string) {}

  /**
   * Initializes the database schema.
   */
  async init() {
    return void await db.run(
      `
      CREATE TABLE IF NOT EXISTS jobs (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        workflow_id TEXT NOT NULL,
        concurrency_key TEXT,
        status TEXT DEFAULT 'pending',
        worker_id TEXT,
        payload JSON,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        started_at DATETIME,
        finished_at DATETIME
      );
    `,
      [],
    );
  }

  /**
   * Enqueues a new job into the database.
   * Includes simple GitHub-style concurrency cancellation.
   */
  async enqueue(workflowId: string, payload: any, concurrencyKey?: string) {
    // If a concurrency key is provided, cancel existing pending/running jobs in that group
    if (concurrencyKey) {
      await db.run(
        `
        UPDATE jobs
        SET status = 'cancelling'
        WHERE concurrency_key = ? AND status IN ('pending', 'running')
      `,
        [concurrencyKey],
      );
    }

    const res = await db.run(
      `
      INSERT INTO jobs (workflow_id, concurrency_key, payload)
      VALUES (?, ?, ?)
    `,
      [workflowId, concurrencyKey || null, JSON.stringify(payload)],
    );

    return res;
  }

  /**
   * ATOMICALY claims the oldest pending job.
   * Requires SQLite >= 3.35 for the RETURNING clause.
   */
  async claimNextJob(): Promise<JobRecord | null> {
    // This query is completely immune to HTTP/Network race conditions.
    // It locks the row, updates it, and returns the data in one transaction.
    const result = await db.get(
      `
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
    `,
      [this.workerId],
    );

    return result ? (result as JobRecord) : null;
  }

  /**
   * Marks a job as completed or failed
   */
  async finishJob(jobId: number, status: 'success' | 'failed') {
    await db.run(
      `
      UPDATE jobs
      SET status = ?, finished_at = CURRENT_TIMESTAMP
      WHERE id = ?
    `,
      [status, jobId],
    );
  }

  /**
   * Checks if the current job has been marked for cancellation by another event
   */
  async isCancelled(jobId: number): Promise<boolean> {
    const job = await db.get(`SELECT status FROM jobs WHERE id = ?`, [jobId]);
    return job?.status === 'cancelling';
  }
}
