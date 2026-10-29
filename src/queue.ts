import db from "./db-client.js";
import { WorkflowExecutionReport, JobPayload, JobRecord, JobStatus } from "./types.js";
import { timestampLogLines } from "./timestamped-log.js";
import { FileStorage } from "./file-storage.js";
import { ensureTeamDataSchema } from "./team-data-schema.js";
import { SecretRepository } from "./secret-repository.js";

const payloadSecrets = new SecretRepository();
const encryptPayload = (payload: JobPayload): string =>
  `enc:v1:${payloadSecrets.encryptValue(JSON.stringify(payload))}`;
const decryptPayload = (payload: unknown): JobPayload => {
  let decoded: JobPayload;
  if (typeof payload !== "string" || !payload.startsWith("enc:v1:")) {
    decoded = (typeof payload === "string" ? JSON.parse(payload) : payload) as JobPayload;
  } else {
    decoded = JSON.parse(payloadSecrets.decryptValue(payload.slice("enc:v1:".length))) as JobPayload;
  }
  const raw = decoded?.inputsRaw as unknown;
  if (raw && typeof raw === "object" && (raw as { type?: unknown }).type === "Buffer") {
    decoded.inputsRaw = Buffer.from((raw as { data: number[] }).data);
  }
  return decoded;
};

function globMatches(value: unknown, pattern: string): boolean {
  if (value === null || value === undefined) {
    return false;
  }
  const text = typeof value === "string" ? value : typeof value === "object" ? JSON.stringify(value) : String(value);
  const expression = [...pattern]
    .map((character) => {
      if (character === "*") {
        return ".*";
      }
      if (character === "?") {
        return ".";
      }
      return character.replace(/[\\^$.*+?()[\]{}|]/g, "\\$&");
    })
    .join("");
  return new RegExp(`^${expression}$`).test(text);
}

function matchesPayloadFilter(payload: unknown, filter: string): boolean {
  const serialized = JSON.stringify(payload);
  const separator = filter.indexOf(":");
  if (separator > 0) {
    const field = filter.slice(0, separator).trim();
    const pattern = filter.slice(separator + 1).trim();
    if (!/^[A-Za-z0-9_-]+$/.test(field) || !pattern) {
      throw new Error("Invalid job filter");
    }
    const inputs = (payload as any)?.inputs;
    return inputs && typeof inputs === "object" ? globMatches(inputs[field], pattern) : false;
  }
  return serialized.toLowerCase().includes(filter.toLowerCase());
}

const CURRENT_RUNNER_AUTHORIZATION = `EXISTS (
  SELECT 1 FROM runners AS authorized_runner
  WHERE authorized_runner.id = jobs.worker_id AND authorized_runner.revoked_at IS NULL
    AND (
      (authorized_runner.scope = 'team' AND authorized_runner.team_id = jobs.team_id)
      OR (authorized_runner.scope = 'shared' AND EXISTS (
        SELECT 1 FROM runner_team_grants AS authorized_grant
        WHERE authorized_grant.runner_id = authorized_runner.id AND authorized_grant.team_id = jobs.team_id
      ))
    )
)`;

export class QueueManager {
  private readonly purgingTeams = new Set<string>();
  private readonly activeStorageWrites = new Map<string, Set<Promise<void>>>();
  private readonly fileStorage = new FileStorage();

  constructor(private workerId: string) {}

  async init() {
    await this.createTables();
    await ensureTeamDataSchema();
    await this.clearStaleJobs();
  }

  /**
   * Enqueues a new job into the database.
   * Includes simple GitHub-style concurrency cancellation.
   */
  async enqueue(
    workflowId: string,
    workflowRevision: number,
    payload: JobPayload,
    requiredTags: string[] = [],
    concurrencyKey?: string,
  ) {
    const res = await db.run(
      `INSERT INTO jobs (workflow_id, workflow_revision, required_tags, concurrency_key, payload, team_id)
       SELECT ?, ?, ?, ?, ?, workflows.team_id FROM workflows
       JOIN teams ON teams.id = workflows.team_id
        WHERE workflows.id = ? AND teams.deleting_at IS NULL
          AND NOT EXISTS (
            SELECT 1 FROM workflow_revisions wr
            JOIN recipe_versions rv ON rv.namespace = json_extract(wr.normalized_json, '$._recipeRef.namespace')
              AND rv.slug = json_extract(wr.normalized_json, '$._recipeRef.slug')
              AND rv.version = json_extract(wr.normalized_json, '$._recipeRef.version')
            WHERE wr.workflow_id = workflows.id AND wr.revision = ? AND rv.revoked = 1
          )`,
      [
        workflowId,
        workflowRevision,
        JSON.stringify(requiredTags),
        concurrencyKey || "",
        encryptPayload(payload),
        workflowId,
        workflowRevision,
      ],
    );

    const jobId = Number(res?.lastInsertRowid ?? res?.id ?? 0);
    if (!jobId) {
      throw new Error("Workflow workspace is unavailable or being deleted");
    }
    if (concurrencyKey) {
      await db.run(
        `UPDATE jobs SET status = 'cancelled', updated_at = CURRENT_TIMESTAMP
         WHERE id <> ? AND team_id = (SELECT team_id FROM jobs WHERE id = ?)
           AND concurrency_key = ? AND status IN ('pending', 'running')`,
        [jobId, jobId, concurrencyKey],
      );
    }
    return jobId;
  }

  /** Enqueue once for a source job/step; unique dispatch key makes retries safe. */
  async enqueueDispatch(
    workflowId: string,
    workflowRevision: number,
    payload: JobPayload,
    requiredTags: string[],
    teamId: string,
    parentId: string | number | null,
    dispatchKey: string,
    admissionFence?: {
      eventId: string;
      variantIndex: number;
      leaseToken: string;
    },
  ): Promise<number> {
    await db.run(
      `INSERT INTO jobs (parentId, workflow_id, workflow_revision, required_tags, concurrency_key, payload, team_id, dispatch_key)
       SELECT ?, ?, ?, ?, '', ?, ?, ?
        WHERE EXISTS (
          SELECT 1 FROM workflows JOIN teams ON teams.id = workflows.team_id
          WHERE workflows.id = ? AND workflows.team_id = ? AND teams.deleting_at IS NULL
            AND NOT EXISTS (
              SELECT 1 FROM workflow_revisions wr
              JOIN recipe_versions rv ON rv.namespace = json_extract(wr.normalized_json, '$._recipeRef.namespace')
                AND rv.slug = json_extract(wr.normalized_json, '$._recipeRef.slug')
                AND rv.version = json_extract(wr.normalized_json, '$._recipeRef.version')
              WHERE wr.workflow_id = workflows.id AND wr.revision = ? AND rv.revoked = 1
        )
        AND (? IS NULL OR EXISTS (
          SELECT 1 FROM workflow_run_admissions a
           WHERE a.event_id = ? AND a.variant_index = ? AND a.status = 'claimed'
             AND a.lease_token = ? AND julianday(a.lease_until) > julianday('now')
        ))
       )
       ON CONFLICT(dispatch_key) DO NOTHING`,
      [
        parentId,
        workflowId,
        workflowRevision,
        JSON.stringify(requiredTags),
        encryptPayload(payload),
        teamId,
        dispatchKey,
        workflowId,
        teamId,
        workflowRevision,
        admissionFence ? 1 : null,
        admissionFence?.eventId ?? null,
        admissionFence?.variantIndex ?? null,
        admissionFence?.leaseToken ?? null,
      ],
    );
    const existing = await db.get("SELECT id FROM jobs WHERE dispatch_key = ? AND team_id = ?", [dispatchKey, teamId]);
    if (existing) {
      return Number(existing.id);
    }
    return 0;
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
        started_at = CURRENT_TIMESTAMP,
        updated_at = CURRENT_TIMESTAMP
      WHERE id = (
        SELECT id FROM jobs
        WHERE status = 'pending'
         AND EXISTS (SELECT 1 FROM teams WHERE teams.id = jobs.team_id AND teams.deleting_at IS NULL)
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

    return result ? ({ ...result, payload: decryptPayload(result.payload) } as JobRecord) : null;
  }

  /** Atomically claims an API job only for teams granted to the authenticated runner. */
  async claimNextForRunner(
    runnerId: string,
    workerTags: string[],
    teamIds: string[],
    leaseId: string,
    leaseTokenHash: string,
    leaseSeconds: number,
    maxActiveJobs: number,
  ): Promise<JobRecord | null> {
    if (!teamIds.length) {
      return null;
    }
    const result = await db.get(
      `UPDATE jobs
       SET status = 'running', worker_id = ?, started_at = CURRENT_TIMESTAMP,
           lease_id = ?, lease_token_hash = ?, lease_expires_at = datetime('now', ?), lease_fenced = 0, lease_completed = 0
       WHERE id = (
          SELECT id FROM jobs
          WHERE status = 'pending'
            AND team_id IN (SELECT value FROM json_each(?))
            AND EXISTS (
              SELECT 1 FROM runners AS claiming_runner
              WHERE claiming_runner.id = ? AND claiming_runner.revoked_at IS NULL
                AND claiming_runner.current_update_id IS NULL
                AND ((claiming_runner.scope = 'team' AND claiming_runner.team_id = jobs.team_id)
                  OR (claiming_runner.scope = 'shared' AND EXISTS (
                    SELECT 1 FROM runner_team_grants AS claiming_grant
                    WHERE claiming_grant.runner_id = claiming_runner.id AND claiming_grant.team_id = jobs.team_id
                  )))
            )
            AND (SELECT COUNT(*) FROM jobs active WHERE active.worker_id = ? AND
              (active.status = 'running' OR (active.status = 'cancelled' AND active.lease_completed = 0))) < ?
           AND NOT EXISTS (
             SELECT 1 FROM json_each(COALESCE(jobs.required_tags, '[]')) AS required_tag
             WHERE required_tag.value NOT IN (SELECT value FROM json_each(?))
           )
         ORDER BY created_at ASC
         LIMIT 1
       )
       RETURNING *`,
      [
        runnerId,
        leaseId,
        leaseTokenHash,
        `+${leaseSeconds} seconds`,
        JSON.stringify(teamIds),
        runnerId,
        runnerId,
        maxActiveJobs,
        JSON.stringify(workerTags),
      ],
    );
    return result ? ({ ...result, payload: decryptPayload(result.payload) } as JobRecord) : null;
  }

  async leaseIsCurrent(jobId: string | number, runnerId: string, leaseId: string, leaseTokenHash: string) {
    const lease = await db.get(
      `SELECT 1 AS valid FROM jobs WHERE id = ? AND worker_id = ? AND lease_id = ?
       AND lease_token_hash = ? AND status = 'running' AND lease_fenced = 0 AND lease_completed = 0
       AND julianday(lease_expires_at) > julianday('now') AND ${CURRENT_RUNNER_AUTHORIZATION}`,
      [jobId, runnerId, leaseId, leaseTokenHash],
    );
    return Boolean(lease);
  }

  async releaseJob(jobId: string | number): Promise<void> {
    await db.run(
      `UPDATE jobs SET status = 'pending', worker_id = NULL, started_at = NULL, lease_id = NULL,
       lease_token_hash = NULL, lease_expires_at = NULL WHERE id = ? AND status = 'running';`,
      [jobId],
    );
  }

  /**
   * Marks a job as completed or failed
   */
  async finishJob(jobId: string | number, status: JobStatus) {
    await db.run(
      `UPDATE jobs SET status = ?, updated_at = CURRENT_TIMESTAMP, finished_at = CURRENT_TIMESTAMP WHERE id = ?;`,
      [status, jobId],
    );
  }

  async completeJob(jobId: string | number, status: JobStatus, report: WorkflowExecutionReport): Promise<void> {
    if (typeof db.transaction !== "function") {
      throw new Error("Atomic transactions are required to complete jobs");
    }
    await db.transaction([
      {
        s: `UPDATE jobs
            SET status = CASE WHEN status = 'cancelled' THEN 'cancelled' ELSE ? END,
                report = ?, updated_at = CURRENT_TIMESTAMP, finished_at = CURRENT_TIMESTAMP,
                lease_id = NULL, lease_token_hash = NULL, lease_expires_at = NULL, lease_completed = 1
            WHERE id = ?`,
        d: [status, JSON.stringify(report), jobId],
        m: "run",
      },
      {
        s: `INSERT OR IGNORE INTO domain_events
              (id, team_id, type, schema_version, source, occurred_at, recorded_at, correlation_id, causation_id,
               idempotency_key, data_json)
            SELECT 'workflow-job:' || jobs.id || ':terminal', jobs.team_id,
              CASE jobs.status WHEN 'success' THEN 'workflow.completed' ELSE 'workflow.failed' END,
              1, 'runner', jobs.finished_at, CURRENT_TIMESTAMP, NULL, NULL,
              'workflow-job:' || jobs.id || ':terminal',
              json_object('teamId', jobs.team_id, 'workflowId', jobs.workflow_id,
                'revision', jobs.workflow_revision, 'jobId', jobs.id, 'status', jobs.status,
                'finishedAt', jobs.finished_at)
            FROM jobs WHERE jobs.id = ? AND jobs.status IN ('success', 'failed')`,
        d: [jobId],
        m: "run",
      },
    ]);
  }

  async completeJobForRunner(
    jobId: string | number,
    runnerId: string,
    leaseId: string,
    leaseTokenHash: string,
    status: JobStatus,
    report: WorkflowExecutionReport,
  ): Promise<boolean> {
    if (typeof db.transaction !== "function") {
      throw new Error("Atomic transactions are required to complete runner jobs");
    }
    const update = `UPDATE jobs SET status = CASE WHEN status = 'cancelled' THEN 'cancelled' ELSE ? END,
       report = ?, updated_at = CURRENT_TIMESTAMP, finished_at = CURRENT_TIMESTAMP, lease_completed = 1
       WHERE id = ? AND worker_id = ? AND lease_id = ? AND lease_token_hash = ? AND status IN ('running', 'cancelled')
         AND lease_fenced = 0 AND lease_completed = 0 AND julianday(lease_expires_at) > julianday('now')
         AND ${CURRENT_RUNNER_AUTHORIZATION}`;
    const insertEvent = `INSERT OR IGNORE INTO domain_events
       (id, team_id, type, schema_version, source, occurred_at, recorded_at, correlation_id, causation_id,
        idempotency_key, data_json)
       SELECT 'workflow-job:' || jobs.id || ':terminal', jobs.team_id,
         CASE jobs.status WHEN 'success' THEN 'workflow.completed' ELSE 'workflow.failed' END,
         1, 'runner', jobs.finished_at, CURRENT_TIMESTAMP, NULL, NULL,
         'workflow-job:' || jobs.id || ':terminal',
         json_object('teamId', jobs.team_id, 'workflowId', jobs.workflow_id,
           'revision', jobs.workflow_revision, 'jobId', jobs.id, 'status', jobs.status,
           'finishedAt', jobs.finished_at)
       FROM jobs WHERE jobs.id = ? AND jobs.worker_id = ? AND jobs.lease_id = ? AND jobs.lease_token_hash = ?
         AND jobs.lease_fenced = 0 AND jobs.lease_completed = 1 AND jobs.status IN ('success', 'failed')
         AND ${CURRENT_RUNNER_AUTHORIZATION}`;
    await db.transaction([
      {
        s: update,
        d: [status, JSON.stringify(report), jobId, runnerId, leaseId, leaseTokenHash],
        m: "run",
      },
      {
        s: insertEvent,
        d: [jobId, runnerId, leaseId, leaseTokenHash],
        m: "run",
      },
    ]);
    const completed = await db.get(
      `SELECT status, report FROM jobs WHERE id = ? AND worker_id = ? AND lease_id = ? AND lease_token_hash = ?
        AND lease_fenced = 0 AND julianday(lease_expires_at) > julianday('now') AND ${CURRENT_RUNNER_AUTHORIZATION}`,
      [jobId, runnerId, leaseId, leaseTokenHash],
    );
    if (!completed || completed.status !== status) {
      return false;
    }
    try {
      return JSON.stringify(JSON.parse(completed.report)) === JSON.stringify(report);
    } catch {
      return false;
    }
  }

  async cancelJob(jobId: string | number): Promise<"cancelled" | "not_found" | "not_active"> {
    const job = await this.getJob(jobId);
    if (!job) {
      return "not_found";
    }
    if (job.status !== "pending" && job.status !== "running") {
      return "not_active";
    }

    await db.run(
      `UPDATE jobs SET status = 'cancelled', updated_at = CURRENT_TIMESTAMP, finished_at = CURRENT_TIMESTAMP
       WHERE id = ? AND status IN ('pending', 'running');`,
      [jobId],
    );
    return (await this.getJob(jobId))?.status === "cancelled" ? "cancelled" : "not_active";
  }

  async restartJob(jobId: string | number, manualInputs: Record<string, unknown> = {}) {
    const job = await this.getJob(jobId);

    if (!job) {
      return;
    }

    const activeWorkflow = await db.get(
      `SELECT workflows.active_revision FROM workflows
       JOIN teams ON teams.id = workflows.team_id
       WHERE workflows.id = ? AND teams.deleting_at IS NULL`,
      [job.workflow_id],
    );
    const activeRevision = Number(activeWorkflow?.active_revision);
    if (!Number.isSafeInteger(activeRevision) || activeRevision < 1) {
      throw new Error(`Workflow ${job.workflow_id} has no active revision`);
    }
    const payload = job.payload ? decryptPayload(job.payload) : { inputs: {} };
    payload.inputs = { ...(payload.inputs || {}), ...manualInputs };

    const newJob = await db.get(
      `INSERT INTO jobs (
         parentId, workflow_id, workflow_revision, required_tags, concurrency_key, payload, team_id,
         status, worker_id, report, started_at, finished_at
       )
       SELECT jobs.id, workflow_id, ?, required_tags, concurrency_key, ?, team_id,
               'pending', NULL, NULL, NULL, NULL
        FROM jobs JOIN teams ON teams.id = jobs.team_id
         WHERE jobs.id = ? AND teams.deleting_at IS NULL AND NOT EXISTS (
           SELECT 1 FROM workflow_revisions wr JOIN recipe_versions rv
             ON rv.namespace = json_extract(wr.normalized_json, '$._recipeRef.namespace')
             AND rv.slug = json_extract(wr.normalized_json, '$._recipeRef.slug')
             AND rv.version = json_extract(wr.normalized_json, '$._recipeRef.version')
           WHERE wr.workflow_id = jobs.workflow_id AND wr.revision = ? AND rv.revoked = 1
         )
        RETURNING *`,
      [activeRevision, encryptPayload(payload), jobId, activeRevision],
    );
    if (!newJob?.id) {
      throw new Error("Workflow is unavailable or its pinned recipe has been revoked");
    }
    if (job.status === "running") {
      await db.run(
        "UPDATE jobs SET status = 'cancelled', updated_at = CURRENT_TIMESTAMP, finished_at = CURRENT_TIMESTAMP WHERE id = ?",
        [jobId],
      );
    }
    return newJob?.id;
  }

  /**
   * Checks if the current job has been marked for cancellation by another event
   */
  async isCancelled(jobId: string | number): Promise<boolean> {
    const job = (await db.get(`SELECT status FROM jobs WHERE id = ?;`, [+jobId])) as { status: JobStatus } | null;
    return job?.status === "cancelled";
  }

  async leaseState(jobId: string | number, runnerId: string, leaseId: string, leaseTokenHash: string) {
    return db.get(
      `SELECT status, lease_expires_at AS expiresAt FROM jobs WHERE id = ? AND worker_id = ? AND lease_id = ?
       AND lease_token_hash = ? AND julianday(lease_expires_at) > julianday('now') AND ${CURRENT_RUNNER_AUTHORIZATION}`,
      [jobId, runnerId, leaseId, leaseTokenHash],
    );
  }

  async getLeasedJob(leaseId: string, runnerId: string, leaseTokenHash: string): Promise<JobRecord | null> {
    const job = await db.get(
      `SELECT * FROM jobs WHERE lease_id = ? AND worker_id = ? AND lease_token_hash = ?
       AND status IN ('running', 'cancelled', 'success', 'failed') AND julianday(lease_expires_at) > julianday('now')
       AND ${CURRENT_RUNNER_AUTHORIZATION}`,
      [leaseId, runnerId, leaseTokenHash],
    );
    return job ? ({ ...job, payload: decryptPayload(job.payload) } as JobRecord) : null;
  }

  /**
   * Check if a recipe version has been revoked in the immutable registry.
   * Used as a guard before executing nested recipe calls.
   */
  async isRecipeVersionRevoked(namespace: string, slug: string, version: number): Promise<boolean> {
    const row = await db.get(`SELECT revoked FROM recipe_versions WHERE namespace = ? AND slug = ? AND version = ?`, [
      namespace,
      slug,
      version,
    ]);
    return Boolean(row?.revoked);
  }

  async renewRunnerLease(
    leaseId: string,
    runnerId: string,
    leaseTokenHash: string,
    leaseSeconds: number,
  ): Promise<boolean> {
    const result = await db.run(
      `UPDATE jobs SET lease_expires_at = datetime('now', ?), updated_at = CURRENT_TIMESTAMP
       WHERE lease_id = ? AND worker_id = ? AND lease_token_hash = ?
         AND status = 'running' AND lease_fenced = 0 AND lease_completed = 0
         AND julianday(lease_expires_at) > julianday('now') AND ${CURRENT_RUNNER_AUTHORIZATION}`,
      [`+${leaseSeconds} seconds`, leaseId, runnerId, leaseTokenHash],
    );
    return Number(result?.changes || 0) === 1;
  }

  async releaseRunnerLease(leaseId: string, runnerId: string, leaseTokenHash: string): Promise<boolean> {
    const result = await db.run(
      `UPDATE jobs SET status = 'pending', worker_id = NULL, lease_id = NULL, lease_token_hash = NULL,
       lease_expires_at = NULL, started_at = NULL, lease_completed = 0, updated_at = CURRENT_TIMESTAMP
       WHERE lease_id = ? AND worker_id = ? AND lease_token_hash = ? AND status = 'running'
       AND lease_fenced = 0 AND lease_completed = 0
        AND julianday(lease_expires_at) > julianday('now') AND ${CURRENT_RUNNER_AUTHORIZATION}`,
      [leaseId, runnerId, leaseTokenHash],
    );
    return Number(result?.changes || 0) === 1;
  }

  async revokeRunnerLeasesForTeam(
    runnerId: string,
    teamId: string,
  ): Promise<Array<{ jobId: number; teamId: string; leaseId: string }>> {
    return db.all(
      `UPDATE jobs SET status = 'cancelled', lease_fenced = 1, updated_at = CURRENT_TIMESTAMP
       WHERE worker_id = ? AND team_id = ? AND status IN ('running', 'cancelled') AND lease_completed = 0 AND lease_id IS NOT NULL
       RETURNING id AS jobId, team_id AS teamId, lease_id AS leaseId`,
      [runnerId, teamId],
    );
  }

  async revokeRunnerLeases(runnerId: string): Promise<Array<{ jobId: number; teamId: string; leaseId: string }>> {
    return db.all(
      `UPDATE jobs SET status = 'cancelled', lease_fenced = 1, updated_at = CURRENT_TIMESTAMP
       WHERE worker_id = ? AND status IN ('running', 'cancelled') AND lease_completed = 0 AND lease_id IS NOT NULL
       RETURNING id AS jobId, team_id AS teamId, lease_id AS leaseId`,
      [runnerId],
    );
  }

  async clearStaleJobs() {
    await db.run(
      `UPDATE jobs SET lease_completed = 1, updated_at = CURRENT_TIMESTAMP
       WHERE status = 'cancelled' AND lease_fenced = 0 AND lease_completed = 0 AND lease_id IS NOT NULL
         AND lease_expires_at IS NOT NULL AND julianday(lease_expires_at) <= julianday('now')`,
    );
    return await db.run(
      `UPDATE jobs SET status = 'pending', worker_id = NULL, lease_id = NULL, lease_token_hash = NULL,
       lease_expires_at = NULL, lease_fenced = 0, lease_completed = 0
       WHERE (status = 'running' AND lease_id IS NOT NULL AND (lease_expires_at IS NULL OR julianday(lease_expires_at) <= julianday('now')))
          OR (status = 'cancelled' AND lease_fenced = 1 AND lease_expires_at IS NOT NULL AND julianday(lease_expires_at) <= julianday('now'))
          OR (status = 'running' AND lease_id IS NULL AND started_at < datetime('now', '-1 hour'));`,
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
        finished_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        lease_id TEXT,
        lease_token_hash TEXT,
        lease_expires_at DATETIME,
        lease_fenced INTEGER NOT NULL DEFAULT 0,
        lease_completed INTEGER NOT NULL DEFAULT 0,
        dispatch_key TEXT UNIQUE
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
    await db.run("ALTER TABLE jobs ADD COLUMN lease_id TEXT").catch(() => {});
    await db.run("ALTER TABLE jobs ADD COLUMN lease_token_hash TEXT").catch(() => {});
    await db.run("ALTER TABLE jobs ADD COLUMN lease_expires_at DATETIME").catch(() => {});
    await db.run("ALTER TABLE jobs ADD COLUMN lease_fenced INTEGER NOT NULL DEFAULT 0").catch(() => {});
    await db.run("ALTER TABLE jobs ADD COLUMN lease_completed INTEGER NOT NULL DEFAULT 0").catch(() => {});
    await db.run("ALTER TABLE jobs ADD COLUMN dispatch_key TEXT").catch(() => {});
    await db.exec("CREATE UNIQUE INDEX IF NOT EXISTS idx_jobs_dispatch_key ON jobs(dispatch_key)");
  }

  /**
   * Fetch job details + report by ID
   */
  async getJob(jobId: string | number): Promise<any> {
    const job = await db.get(`SELECT * FROM jobs WHERE id = ?`, [jobId]);
    return job ? { ...job, payload: decryptPayload(job.payload) } : null;
  }

  /** Tenant-scoped job lookup for authenticated server requests. */
  async getJobForTeam(teamId: string, jobId: string | number): Promise<any> {
    const job = await db.get("SELECT * FROM jobs WHERE team_id = ? AND id = ?", [teamId, jobId]);
    return job ? { ...job, payload: decryptPayload(job.payload) } : null;
  }

  /** Read immutable step execution attempts, scoped to the owning team and job. */
  async getStepAttemptsForTeam(teamId: string, jobId: string | number): Promise<any[]> {
    return db.all(
      `SELECT c.id, c.job_id, c.step_id, c.attempt, c.status, c.started_at, c.completed_at,
              c.duration_ms, c.exit_code, c.error, c.log_content, c.attempt_id, 'completed' AS lifecycle_status
              , c.snapshot_json
         FROM step_execution_attempts c
        WHERE c.team_id = ? AND c.job_id = ?
        UNION ALL
       SELECT s.id, s.job_id, s.step_id, s.attempt, 'interrupted_or_unknown' AS status,
              s.started_at, NULL AS completed_at, NULL AS duration_ms, NULL AS exit_code,
                NULL AS error, '' AS log_content, s.attempt_id, 'started' AS lifecycle_status
                , NULL AS snapshot_json
         FROM step_execution_attempt_starts s
        WHERE s.team_id = ? AND s.job_id = ?
          AND NOT EXISTS (
            SELECT 1 FROM step_execution_attempts c
             WHERE c.team_id = s.team_id AND c.job_id = s.job_id
               AND c.step_id = s.step_id AND c.attempt = s.attempt
          )
        ORDER BY step_id ASC, attempt ASC, id ASC`,
      [teamId, jobId, teamId, jobId],
    );
  }

  /** Append the immutable durable fact that a step attempt is about to be invoked. */
  async saveStepAttemptStart(start: {
    jobId: string | number;
    stepId: string;
    attempt: number;
    startedAt: string;
    attemptId: string;
  }): Promise<void> {
    const result = await db.run(
      `INSERT INTO step_execution_attempt_starts (team_id, job_id, step_id, attempt, started_at, attempt_id)
       SELECT team_id, id, ?, ?, ?, ? FROM jobs
         WHERE id = ? AND EXISTS (SELECT 1 FROM teams WHERE teams.id = jobs.team_id AND deleting_at IS NULL)
       ON CONFLICT(job_id, step_id, attempt) DO NOTHING`,
      [start.stepId, start.attempt, start.startedAt, start.attemptId, start.jobId],
    );
    if (Number(result?.changes || 0) !== 1) {
      throw new Error("Step attempt start already exists or could not be persisted; refusing to execute step");
    }
  }

  async saveStepAttemptStartForRunner(
    jobId: string | number,
    runnerId: string,
    leaseId: string,
    leaseTokenHash: string,
    start: {
      stepId: string;
      attempt: number;
      startedAt: string;
      attemptId: string;
    },
  ): Promise<boolean> {
    const result = await db.run(
      `INSERT INTO step_execution_attempt_starts (team_id, job_id, step_id, attempt, started_at, attempt_id)
       SELECT team_id, id, ?, ?, ?, ? FROM jobs WHERE id = ? AND worker_id = ? AND lease_id = ? AND lease_token_hash = ?
         AND status = 'running' AND lease_fenced = 0 AND lease_completed = 0
         AND julianday(lease_expires_at) > julianday('now') AND ${CURRENT_RUNNER_AUTHORIZATION}
         AND EXISTS (SELECT 1 FROM teams WHERE teams.id = jobs.team_id AND deleting_at IS NULL)
       ON CONFLICT(job_id, step_id, attempt) DO NOTHING`,
      [start.stepId, start.attempt, start.startedAt, start.attemptId, jobId, runnerId, leaseId, leaseTokenHash],
    );
    if (Number(result?.changes || 0) === 1) {
      return true;
    }
    const existing = await db.get(
      `SELECT 1 AS matched FROM step_execution_attempt_starts s JOIN jobs
          ON jobs.id = s.job_id AND jobs.team_id = s.team_id
        WHERE s.job_id = ? AND s.step_id = ? AND s.attempt = ? AND s.started_at = ? AND s.attempt_id = ?
          AND jobs.worker_id = ? AND jobs.lease_id = ? AND jobs.lease_token_hash = ?
          AND jobs.status = 'running' AND jobs.lease_fenced = 0 AND jobs.lease_completed = 0
          AND julianday(jobs.lease_expires_at) > julianday('now') AND ${CURRENT_RUNNER_AUTHORIZATION}
          AND EXISTS (SELECT 1 FROM teams WHERE teams.id = jobs.team_id AND deleting_at IS NULL)`,
      [jobId, start.stepId, start.attempt, start.startedAt, start.attemptId, runnerId, leaseId, leaseTokenHash],
    );
    return Boolean(existing);
  }

  /**
   * List recent jobs for dashboard status monitoring
   */
  async listJobs(
    limit = 50,
    afterId?: number,
    beforeId?: number,
    filter?: string,
    workflowId?: string,
  ): Promise<any[]> {
    const conditions: string[] = [];
    const values: Array<number | string> = [];

    if (afterId !== undefined) {
      conditions.push("id > ?");
      values.push(afterId);
    }
    if (beforeId !== undefined) {
      conditions.push("id < ?");
      values.push(beforeId);
    }
    if (filter) {
      const separator = filter.indexOf(":");
      if (separator > 0) {
        const field = filter.slice(0, separator).trim();
        const pattern = filter.slice(separator + 1).trim();
        if (!/^[A-Za-z0-9_-]+$/.test(field) || !pattern) {
          throw new Error("Invalid job filter");
        }
        conditions.push("json_extract(payload, '$.inputs.' || ?) GLOB ?");
        values.push(field, pattern);
      } else {
        conditions.push("LOWER(payload) LIKE LOWER(?)");
        values.push(`%${filter}%`);
      }
    }
    if (workflowId) {
      conditions.push("workflow_id = ?");
      values.push(workflowId);
    }

    const where = conditions.length ? ` WHERE ${conditions.join(" AND ")}` : "";
    return db.all(`SELECT * FROM jobs${where} ORDER BY id DESC LIMIT ?;`, [...values, limit]);
  }

  /** Tenant-scoped job listing; teamId is mandatory. */
  async listJobsForTeam(
    teamId: string,
    limit = 50,
    afterId?: number,
    beforeId?: number,
    filter?: string,
    workflowId?: string,
  ): Promise<any[]> {
    const conditions = ["team_id = ?"];
    const values: Array<number | string> = [teamId];
    if (afterId !== undefined) {
      conditions.push("id > ?");
      values.push(afterId);
    }
    if (beforeId !== undefined) {
      conditions.push("id < ?");
      values.push(beforeId);
    }
    if (workflowId) {
      conditions.push("workflow_id = ?");
      values.push(workflowId);
    }
    const columns =
      "id, parentId, workflow_id, workflow_revision, required_tags, concurrency_key, team_id, status, worker_id, report, created_at, updated_at, started_at, finished_at, dispatch_key";
    if (!filter) {
      return db.all(`SELECT ${columns} FROM jobs WHERE ${conditions.join(" AND ")} ORDER BY id DESC LIMIT ?`, [
        ...values,
        limit,
      ]);
    }

    const matches: any[] = [];
    const batchSize = Math.max(100, Math.min(500, limit * 2));
    let beforeCursor: number | undefined = beforeId;
    while (matches.length < limit) {
      const pageConditions = [...conditions];
      const pageValues = [...values];
      if (beforeCursor !== undefined) {
        pageConditions.push("id < ?");
        pageValues.push(beforeCursor);
      }
      const rows = await db.all(
        `SELECT ${columns}, payload FROM jobs WHERE ${pageConditions.join(" AND ")} ORDER BY id DESC LIMIT ?`,
        [...pageValues, batchSize],
      );
      if (!rows.length) {
        break;
      }
      for (const row of rows) {
        beforeCursor = Number(row.id);
        const payload = decryptPayload(row.payload);
        if (matchesPayloadFilter(payload, filter)) {
          const { payload: _payload, ...safeRow } = row;
          matches.push(safeRow);
          if (matches.length === limit) {
            break;
          }
        }
      }
      if (rows.length < batchSize) {
        break;
      }
    }
    return matches;
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

  async saveReportForRunner(
    jobId: string | number,
    runnerId: string,
    leaseId: string,
    leaseTokenHash: string,
    report: WorkflowExecutionReport,
  ): Promise<boolean> {
    const result = await db.run(
      `UPDATE jobs SET report = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ? AND worker_id = ? AND lease_id = ?
         AND lease_token_hash = ? AND status IN ('running', 'cancelled') AND lease_fenced = 0 AND lease_completed = 0
         AND julianday(lease_expires_at) > julianday('now') AND ${CURRENT_RUNNER_AUTHORIZATION}`,
      [JSON.stringify(report), jobId, runnerId, leaseId, leaseTokenHash],
    );
    return Number(result?.changes || 0) === 1;
  }

  /** Save or replace the durable log snapshot for a step. */
  async saveStepLog(jobId: string | number, stepId: string, logContent: string): Promise<void> {
    await db.run(
      `INSERT INTO step_logs (job_id, step_id, log_content)
       SELECT ?, ?, ? WHERE EXISTS (
         SELECT 1 FROM jobs JOIN teams ON teams.id = jobs.team_id
         WHERE jobs.id = ? AND teams.deleting_at IS NULL
       )
       ON CONFLICT(job_id, step_id) DO UPDATE SET
         log_content = excluded.log_content,
         created_at = CURRENT_TIMESTAMP`,
      [jobId, stepId, timestampLogLines(logContent), jobId],
    );
  }

  async saveStepLogForRunner(
    jobId: string | number,
    runnerId: string,
    leaseId: string,
    leaseTokenHash: string,
    stepId: string,
    logContent: string,
  ): Promise<boolean> {
    const result = await db.run(
      `INSERT INTO step_logs (job_id, step_id, log_content)
       SELECT ?, ?, ? WHERE EXISTS (
          SELECT 1 FROM jobs JOIN teams ON teams.id = jobs.team_id
           WHERE jobs.id = ? AND worker_id = ? AND lease_id = ? AND lease_token_hash = ?
           AND status IN ('running', 'cancelled') AND lease_fenced = 0 AND lease_completed = 0
            AND teams.deleting_at IS NULL
           AND julianday(lease_expires_at) > julianday('now') AND ${CURRENT_RUNNER_AUTHORIZATION}
       )
       ON CONFLICT(job_id, step_id) DO UPDATE SET log_content = excluded.log_content, created_at = CURRENT_TIMESTAMP`,
      [jobId, stepId, timestampLogLines(logContent), jobId, runnerId, leaseId, leaseTokenHash],
    );
    return Number(result?.changes || 0) === 1;
  }

  /** Persist an immutable per-execution record. Legacy local workers do not carry lease identity. */
  async saveStepAttempt(attempt: {
    jobId: string | number;
    stepId: string;
    attempt: number;
    status: string;
    startedAt: string;
    completedAt: string;
    durationMs: number;
    exitCode?: number;
    error?: string;
    logContent: string;
    attemptId: string;
    snapshotJson?: string;
  }): Promise<void> {
    if (attempt.snapshotJson !== undefined && Buffer.byteLength(attempt.snapshotJson, "utf8") > 65536) {
      throw new Error("Step attempt snapshot exceeds the 64 KiB limit");
    }
    const result = await db.run(
      `INSERT INTO step_execution_attempts
       (team_id, job_id, step_id, attempt, status, started_at, completed_at, duration_ms, exit_code, error, log_content, attempt_id, snapshot_json)
       SELECT team_id, id, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ? FROM jobs
        WHERE id = ? AND EXISTS (SELECT 1 FROM teams WHERE teams.id = jobs.team_id AND deleting_at IS NULL)
          AND EXISTS (SELECT 1 FROM step_execution_attempt_starts s WHERE s.job_id = jobs.id
            AND s.step_id = ? AND s.attempt = ? AND s.started_at = ? AND s.attempt_id = ?)
       ON CONFLICT(job_id, step_id, attempt) DO NOTHING`,
      [
        attempt.stepId,
        attempt.attempt,
        attempt.status,
        attempt.startedAt,
        attempt.completedAt,
        attempt.durationMs,
        attempt.exitCode ?? null,
        attempt.error?.slice(0, 4000) ?? null,
        attempt.logContent.slice(0, 65536),
        attempt.attemptId,
        attempt.snapshotJson ?? null,
        attempt.jobId,
        attempt.stepId,
        attempt.attempt,
        attempt.startedAt,
        attempt.attemptId,
      ],
    );
    if (Number(result?.changes || 0) === 1) {
      return;
    }
    const existing = await db.get(
      `SELECT 1 AS matched FROM step_execution_attempts a
        JOIN jobs j ON j.id = a.job_id AND j.team_id = a.team_id
        WHERE a.job_id = ? AND a.step_id = ? AND a.attempt = ? AND a.attempt_id = ?
          AND a.status = ? AND a.started_at = ? AND a.completed_at = ? AND a.duration_ms = ?
          AND a.exit_code IS ? AND a.error IS ? AND a.log_content = ? AND a.snapshot_json IS ?`,
      [
        attempt.jobId,
        attempt.stepId,
        attempt.attempt,
        attempt.attemptId,
        attempt.status,
        attempt.startedAt,
        attempt.completedAt,
        attempt.durationMs,
        attempt.exitCode ?? null,
        attempt.error?.slice(0, 4000) ?? null,
        attempt.logContent.slice(0, 65536),
        attempt.snapshotJson ?? null,
      ],
    );
    if (!existing) {
      throw new Error("Step attempt completion does not match its durable start");
    }
  }

  async saveStepAttemptForRunner(
    runnerId: string,
    leaseId: string,
    leaseTokenHash: string,
    attempt: {
      jobId: string | number;
      stepId: string;
      attempt: number;
      status: string;
      startedAt: string;
      completedAt: string;
      durationMs: number;
      exitCode?: number;
      error?: string;
      logContent: string;
      attemptId: string;
      snapshotJson?: string;
    },
  ): Promise<boolean> {
    if (attempt.snapshotJson !== undefined && Buffer.byteLength(attempt.snapshotJson, "utf8") > 65536) {
      return false;
    }
    const result = await db.run(
      `INSERT INTO step_execution_attempts
       (team_id, job_id, step_id, attempt, status, started_at, completed_at, duration_ms, exit_code, error, log_content, attempt_id, snapshot_json)
       SELECT team_id, id, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ? FROM jobs
        WHERE id = ? AND worker_id = ? AND lease_id = ? AND lease_token_hash = ? AND status = 'running'
          AND lease_fenced = 0 AND lease_completed = 0 AND julianday(lease_expires_at) > julianday('now')
           AND ${CURRENT_RUNNER_AUTHORIZATION} AND EXISTS (SELECT 1 FROM teams WHERE teams.id = jobs.team_id AND deleting_at IS NULL)
           AND EXISTS (SELECT 1 FROM step_execution_attempt_starts s WHERE s.job_id = jobs.id AND s.step_id = ?
             AND s.attempt = ? AND s.attempt_id = ?)
       ON CONFLICT(job_id, step_id, attempt) DO NOTHING`,
      [
        attempt.stepId,
        attempt.attempt,
        attempt.status,
        attempt.startedAt,
        attempt.completedAt,
        attempt.durationMs,
        attempt.exitCode ?? null,
        attempt.error?.slice(0, 4000) ?? null,
        attempt.logContent.slice(0, 65536),
        attempt.attemptId,
        attempt.snapshotJson ?? null,
        attempt.jobId,
        attempt.stepId,
        attempt.attempt,
        attempt.attemptId,
        runnerId,
        leaseId,
        leaseTokenHash,
      ],
    );
    if (Number(result?.changes || 0) === 1) {
      return true;
    }
    const existing = await db.get(
      `SELECT 1 AS matched FROM step_execution_attempts a JOIN jobs
          ON jobs.id = a.job_id AND jobs.team_id = a.team_id
        WHERE a.job_id = ? AND a.step_id = ? AND a.attempt = ? AND a.attempt_id = ? AND a.status = ?
          AND a.started_at = ? AND a.completed_at = ? AND a.duration_ms = ?
          AND a.exit_code IS ? AND a.error IS ? AND a.log_content = ? AND a.snapshot_json IS ?
          AND jobs.worker_id = ? AND jobs.lease_id = ? AND jobs.lease_token_hash = ?
          AND jobs.status = 'running' AND jobs.lease_fenced = 0 AND jobs.lease_completed = 0
          AND julianday(jobs.lease_expires_at) > julianday('now') AND ${CURRENT_RUNNER_AUTHORIZATION}
          AND EXISTS (SELECT 1 FROM teams WHERE teams.id = jobs.team_id AND deleting_at IS NULL)`,
      [
        attempt.jobId,
        attempt.stepId,
        attempt.attempt,
        attempt.attemptId,
        attempt.status,
        attempt.startedAt,
        attempt.completedAt,
        attempt.durationMs,
        attempt.exitCode ?? null,
        attempt.error?.slice(0, 4000) ?? null,
        attempt.logContent.slice(0, 65536),
        attempt.snapshotJson ?? null,
        runnerId,
        leaseId,
        leaseTokenHash,
      ],
    );
    return Boolean(existing);
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

  async saveStoredFiles(
    kind: "artifact" | "cache",
    ownerKey: string,
    files: Array<{ path: string; content: string }>,
  ): Promise<void> {
    const owner =
      kind === "artifact"
        ? await db.get(
            `SELECT jobs.team_id AS teamId FROM jobs JOIN teams ON teams.id = jobs.team_id
             WHERE jobs.id = ? AND teams.deleting_at IS NULL`,
            [ownerKey],
          )
        : await db.get(
            `SELECT workflows.team_id AS teamId FROM workflows JOIN teams ON teams.id = workflows.team_id
             WHERE workflows.id = ? AND teams.deleting_at IS NULL`,
            [ownerKey.split(":", 1)[0]],
          );
    if (!owner || this.purgingTeams.has(owner.teamId)) {
      return;
    }
    await this.trackStorageWrite(owner.teamId, async () => {
      if (this.fileStorage.enabled) {
        await this.fileStorage.save(`${kind}/${ownerKey}`, files);
        return;
      }
      for (const file of files) {
        await db.run(
          `INSERT INTO stored_files (kind, owner_key, file_path, content) VALUES (?, ?, ?, ?)
           ON CONFLICT(kind, owner_key, file_path) DO UPDATE SET content = excluded.content, created_at = CURRENT_TIMESTAMP`,
          [kind, ownerKey, file.path, file.content],
        );
      }
    });
  }

  private async trackStorageWrite(teamId: string, write: () => Promise<void>): Promise<void> {
    if (this.purgingTeams.has(teamId)) {
      return;
    }
    const writes = this.activeStorageWrites.get(teamId) || new Set<Promise<void>>();
    const pending = Promise.resolve().then(write);
    writes.add(pending);
    this.activeStorageWrites.set(teamId, writes);
    try {
      await pending;
    } finally {
      writes.delete(pending);
      if (!writes.size) {
        this.activeStorageWrites.delete(teamId);
      }
    }
  }

  async getStoredFiles(
    kind: "artifact" | "cache",
    ownerKey: string,
  ): Promise<Array<{ path: string; content: string }>> {
    if (this.fileStorage.enabled) {
      return this.fileStorage.load(`${kind}/${ownerKey}`);
    }
    return db.all("SELECT file_path AS path, content FROM stored_files WHERE kind = ? AND owner_key = ?", [
      kind,
      ownerKey,
    ]);
  }

  async saveStoredFilesForRunner(
    kind: "artifact" | "cache",
    ownerKey: string,
    files: Array<{ path: string; content: string }>,
    jobId: string | number,
    runnerId: string,
    leaseId: string,
    leaseTokenHash: string,
  ): Promise<boolean> {
    for (const file of files) {
      const result = await db.run(
        `INSERT INTO stored_files (kind, owner_key, file_path, content)
         SELECT ?, ?, ?, ? WHERE EXISTS (
           SELECT 1 FROM jobs JOIN teams ON teams.id = jobs.team_id
            WHERE jobs.id = ? AND worker_id = ? AND lease_id = ? AND lease_token_hash = ?
            AND status = 'running' AND lease_fenced = 0 AND lease_completed = 0
            AND teams.deleting_at IS NULL
           AND julianday(lease_expires_at) > julianday('now') AND ${CURRENT_RUNNER_AUTHORIZATION}
         )
         ON CONFLICT(kind, owner_key, file_path) DO UPDATE SET content = excluded.content, created_at = CURRENT_TIMESTAMP`,
        [kind, ownerKey, file.path, file.content, jobId, runnerId, leaseId, leaseTokenHash],
      );
      if (Number(result?.changes || 0) !== 1) {
        return false;
      }
    }
    return true;
  }

  async getStoredFilesForRunner(
    kind: "artifact" | "cache",
    ownerKey: string,
    jobId: string | number,
    runnerId: string,
    leaseId: string,
    leaseTokenHash: string,
  ): Promise<Array<{ path: string; content: string }>> {
    return db.all(
      `SELECT file_path AS path, content FROM stored_files WHERE kind = ? AND owner_key = ? AND EXISTS (
         SELECT 1 FROM jobs WHERE id = ? AND worker_id = ? AND lease_id = ? AND lease_token_hash = ?
         AND status = 'running' AND lease_fenced = 0 AND lease_completed = 0
         AND julianday(lease_expires_at) > julianday('now') AND ${CURRENT_RUNNER_AUTHORIZATION}
       )`,
      [kind, ownerKey, jobId, runnerId, leaseId, leaseTokenHash],
    );
  }

  async getStoredFilesForTeam(
    teamId: string,
    kind: "artifact" | "cache",
    jobId: string | number,
  ): Promise<Array<{ path: string; content: string }>> {
    if (!(await this.getJobForTeam(teamId, jobId))) {
      return [];
    }
    const runnerFiles = await db.all(
      "SELECT file_path AS path, content FROM stored_files WHERE kind = ? AND owner_key = ?",
      [kind, String(jobId)],
    );
    return runnerFiles.length ? runnerFiles : this.getStoredFiles(kind, String(jobId));
  }

  /**
   * Permanently purge one workspace-owned run and everything derived from it:
   * step logs, stored artifacts and caches, and saved AI requests.
   */
  async deleteJobForTeam(teamId: string, jobId: string | number): Promise<boolean> {
    const job = await this.getJobForTeam(teamId, jobId);
    if (!job) {
      return false;
    }
    if (this.fileStorage.enabled) {
      await this.fileStorage.delete(`artifact/${jobId}`);
    }
    const statements = [
      { s: "DELETE FROM step_logs WHERE job_id = ?", d: [jobId], m: "run" },
      {
        s: "DELETE FROM stored_files WHERE owner_key = ?",
        d: [String(jobId)],
        m: "run",
      },
      { s: "DELETE FROM ai_requests WHERE job_id = ?", d: [jobId], m: "run" },
      {
        s: "UPDATE jobs SET parentId = NULL WHERE parentId = ? AND team_id = ?",
        d: [jobId, teamId],
        m: "run",
      },
      {
        s: "DELETE FROM jobs WHERE id = ? AND team_id = ?",
        d: [jobId, teamId],
        m: "run",
      },
    ];
    if (typeof db.transaction !== "function") {
      throw new Error("Atomic transactions are required to delete run data");
    }
    await db.transaction(statements);
    return true;
  }

  /** Purge external workspace files before the owning SQL records are removed. */
  async deleteJobsForTeam(teamId: string): Promise<void> {
    this.purgingTeams.add(teamId);
    await Promise.all(this.activeStorageWrites.get(teamId) || []);
    const workflowRows = await db.all("SELECT id FROM workflows WHERE team_id = ?", [teamId]);
    const jobs = await db.all("SELECT id FROM jobs WHERE team_id = ?", [teamId]);
    if (this.fileStorage.enabled) {
      for (const workflow of workflowRows) {
        await this.fileStorage.delete(`cache/${workflow.id}:`);
      }
      for (const job of jobs) {
        await this.fileStorage.delete(`artifact/${job.id}`);
      }
    }
  }

  async updateWorkerPresence(worker: {
    id: string;
    version: string;
    tags: string[];
    concurrency: number;
    activeJobs: number;
  }): Promise<void> {
    await db.run(
      `INSERT INTO worker_presence (worker_id, version, tags, concurrency, active_jobs, last_seen)
       VALUES (?, ?, ?, ?, ?, CURRENT_TIMESTAMP)
       ON CONFLICT(worker_id) DO UPDATE SET version = excluded.version, tags = excluded.tags,
       concurrency = excluded.concurrency, active_jobs = excluded.active_jobs, last_seen = CURRENT_TIMESTAMP`,
      [worker.id, worker.version, JSON.stringify(worker.tags), worker.concurrency, worker.activeJobs],
    );
  }

  async listWorkerPresence(): Promise<any[]> {
    const rows = await db.all(
      "SELECT worker_id, version, tags, concurrency, active_jobs, last_seen FROM worker_presence ORDER BY worker_id",
    );
    return rows.map((row: any) => ({
      workerId: row.worker_id,
      version: row.version,
      tags: JSON.parse(row.tags || "[]"),
      concurrency: row.concurrency,
      activeJobs: row.active_jobs,
      lastSeen: row.last_seen,
      online: Date.now() - Date.parse(`${row.last_seen}Z`) < 45_000,
    }));
  }

  async saveAiRequest(jobId: string | number, workflowUrl: string, request: unknown): Promise<void> {
    await db.run("INSERT INTO ai_requests (job_id, workflow_url, request_json) VALUES (?, ?, ?)", [
      jobId,
      workflowUrl,
      JSON.stringify(request),
    ]);
  }
}
