import crypto from "node:crypto";
import db from "./db-client.js";

export type WorkflowRunVariant = {
  eventId: string;
  teamId: string;
  workflowId: string;
  revision: number;
  index: number;
  matrix: Record<string, unknown>;
  tags: string[];
};

export class WorkflowRunAdmissionRepository {
  async persistTerminal(variant: WorkflowRunVariant, status: "admitted" | "failed", errorCode?: string): Promise<void> {
    await db.run(
      `INSERT OR IGNORE INTO workflow_run_admissions
        (event_id, team_id, workflow_id, revision, variant_index, matrix_json, tags_json, status, error_code)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        variant.eventId,
        variant.teamId,
        variant.workflowId,
        variant.revision,
        variant.index,
        JSON.stringify(variant.matrix),
        JSON.stringify(variant.tags),
        status,
        errorCode ?? null,
      ],
    );
  }

  async persistPlan(variants: WorkflowRunVariant[]): Promise<void> {
    const rows = variants.length ? variants : [];
    if (rows.length === 0) {
      return;
    }
    const first = rows[0];
    const indices = new Set<number>();
    for (const variant of rows) {
      if (
        variant.eventId !== first.eventId ||
        variant.teamId !== first.teamId ||
        variant.workflowId !== first.workflowId ||
        variant.revision !== first.revision ||
        !Number.isInteger(variant.index) ||
        indices.has(variant.index)
      ) {
        throw new Error("Workflow run admission plan is incomplete or inconsistent");
      }
      indices.add(variant.index);
    }
    const statements: Array<{ s: string; d: unknown[]; m: string }> = [];
    for (const variant of rows) {
      statements.push({
        s: `INSERT OR IGNORE INTO workflow_run_admissions
          (event_id, team_id, workflow_id, revision, variant_index, matrix_json, tags_json)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
        d: [
          variant.eventId,
          variant.teamId,
          variant.workflowId,
          variant.revision,
          variant.index,
          JSON.stringify(variant.matrix),
          JSON.stringify(variant.tags),
        ],
        m: "run",
      });
    }
    // The marker insert is part of the same SQLite transaction as the row inserts.
    // Its predicate revalidates every persisted value, so concurrent recovery with
    // a conflicting matrix can never make a mixed plan claimable.
    // SQLite does not support a multi-column VALUES table in every supported
    // engine version; use one correlated existence test per expected variant.
    const exactChecks = rows
      .map(
        () => `EXISTS (SELECT 1 FROM workflow_run_admissions a WHERE a.event_id = ? AND a.variant_index = ?
          AND a.team_id = ? AND a.workflow_id = ? AND a.revision = ? AND a.matrix_json = ? AND a.tags_json = ?)`,
      )
      .join(" AND ");
    const safeMarkerSql = `INSERT OR IGNORE INTO workflow_run_admission_plans (event_id, variant_count, plan_hash)
      SELECT ?, ?, ? WHERE (SELECT COUNT(*) FROM workflow_run_admissions WHERE event_id = ?) = ?
        AND NOT EXISTS (SELECT 1 FROM workflow_run_admissions WHERE event_id = ? AND variant_index NOT IN (${rows.map(() => "?").join(",")}))
        AND ${exactChecks}`;
    const planHash = crypto
      .createHash("sha256")
      .update(
        [...rows]
          .sort((left, right) => left.index - right.index)
          .map((variant) => JSON.stringify(variant))
          .join("\n"),
      )
      .digest("hex");
    const markerValues: unknown[] = [first.eventId, rows.length, planHash, first.eventId, rows.length, first.eventId];
    markerValues.push(...rows.map((variant) => variant.index));
    for (const variant of rows) {
      markerValues.push(
        first.eventId,
        variant.index,
        variant.teamId,
        variant.workflowId,
        variant.revision,
        JSON.stringify(variant.matrix),
        JSON.stringify(variant.tags),
      );
    }
    statements.push({ s: safeMarkerSql, d: markerValues, m: "run" });
    if (!db.transaction) {
      throw new Error("Workflow run admission requires transactional SQLite support");
    }
    await db.transaction(statements);
    const marker = await db.get(
      `SELECT variant_count, plan_hash FROM workflow_run_admission_plans WHERE event_id = ?`,
      [first.eventId],
    );
    if (!marker || Number(marker.variant_count) !== rows.length || marker.plan_hash !== planHash) {
      throw new Error("Workflow run admission plan is incomplete or conflicts with persisted plan");
    }
  }

  async isPlanTerminal(eventId: string, expectedIndices: number[]): Promise<boolean> {
    const rows = await db.all(`SELECT variant_index, status FROM workflow_run_admissions WHERE event_id = ?`, [
      eventId,
    ]);
    if (expectedIndices.length === 0) {
      return rows.length === 1 && Number(rows[0].variant_index) === -2 && rows[0].status === "admitted";
    }
    if (rows.length === 1 && Number(rows[0].variant_index) === -1 && rows[0].status === "failed") {
      return true;
    }
    const marker = await db.get("SELECT variant_count FROM workflow_run_admission_plans WHERE event_id = ?", [eventId]);
    return (
      Boolean(marker) &&
      Number(marker.variant_count) === expectedIndices.length &&
      rows.length === expectedIndices.length &&
      expectedIndices.every((index) =>
        rows.some((row: any) => Number(row.variant_index) === index && ["admitted", "failed"].includes(row.status)),
      )
    );
  }

  /**
   * Claim the next available variant for processing.
   * Returns null if no variant is available.
   *
   * This method handles:
   * - Pending variants (first attempt)
   * - Expired claimed variants (reclaim for retry)
   * - Atomic lock via status update and lease token
   */
  async claimNext(leaseMs = 30_000): Promise<(WorkflowRunVariant & { token: string }) | null> {
    const token = crypto.randomUUID();
    const until = new Date(Date.now() + Math.max(1, leaseMs)).toISOString().replace("T", " ").replace("Z", "");
    const row = await db.get(
      `UPDATE workflow_run_admissions SET status = 'claimed', lease_token = ?, lease_until = ?, updated_at = CURRENT_TIMESTAMP
       WHERE rowid = (SELECT rowid FROM workflow_run_admissions
           WHERE ((status = 'pending' AND (retry_after IS NULL OR julianday(retry_after) <= julianday(?)))
               OR (status = 'claimed' AND julianday(lease_until) <= julianday(?)))
             AND EXISTS (SELECT 1 FROM workflow_run_admission_plans p WHERE p.event_id = workflow_run_admissions.event_id)
          ORDER BY CASE WHEN status = 'claimed' THEN 0 ELSE 1 END, COALESCE(retry_after, updated_at), updated_at, event_id, variant_index LIMIT 1)
       RETURNING *`,
      [token, until, new Date().toISOString(), new Date().toISOString()],
    );
    return row
      ? {
          eventId: row.event_id,
          teamId: row.team_id,
          workflowId: row.workflow_id,
          revision: Number(row.revision),
          index: Number(row.variant_index),
          matrix: JSON.parse(row.matrix_json),
          tags: JSON.parse(row.tags_json),
          token,
        }
      : null;
  }

  /**
   * Reclaim all variants with expired leases back to 'pending' status.
   * This is used for crash recovery: when a server crashes after claiming
   * variants but before updating their status, the expired leases will be
   * reclaimed so other workers can pick them up.
   */
  async reclaimExpired(): Promise<number> {
    const result = await db.run(
      `UPDATE workflow_run_admissions SET status = 'pending', lease_token = NULL, lease_until = NULL, updated_at = CURRENT_TIMESTAMP
       WHERE status = 'claimed' AND lease_until IS NOT NULL AND lease_until <= CURRENT_TIMESTAMP`,
    );
    return Number(result?.changes || 0);
  }

  /**
   * Complete the admission process for a variant.
   * Updates the status from 'claimed' to the final status
   * (admitted, pending, or failed) and records the job_id and error_code if applicable.
   */
  async finish(
    variant: WorkflowRunVariant & { token: string },
    status: "admitted" | "pending" | "failed",
    jobId?: number,
    errorCode?: string,
  ) {
    const result = await db.run(
      `UPDATE workflow_run_admissions SET status = ?, job_id = COALESCE(?, job_id), error_code = ?,
       retry_after = CASE WHEN ? = 'pending' THEN datetime('now', '+' || MIN(300, 5 * (1 + (SELECT COUNT(*) FROM workflow_run_admissions prior WHERE prior.event_id = workflow_run_admissions.event_id AND prior.variant_index = workflow_run_admissions.variant_index))) || ' seconds') ELSE NULL END,
       lease_token = NULL, lease_until = NULL, updated_at = CURRENT_TIMESTAMP
       WHERE event_id = ? AND variant_index = ? AND status = 'claimed' AND lease_token = ?`,
      [status, jobId ?? null, errorCode ?? null, status, variant.eventId, variant.index, variant.token],
    );
    return Number(result?.changes || 0) === 1;
  }

  async ownsLease(variant: WorkflowRunVariant & { token: string }): Promise<boolean> {
    const row = await db.get(
      `SELECT 1 AS owned FROM workflow_run_admissions
       WHERE event_id = ? AND variant_index = ? AND status = 'claimed' AND lease_token = ?
         AND julianday(lease_until) > julianday('now')`,
      [variant.eventId, variant.index, variant.token],
    );
    return Boolean(row);
  }

  async list(eventId: string) {
    return db.all(
      `SELECT event_id, team_id, workflow_id, revision, variant_index, matrix_json, tags_json, status, job_id, error_code
      FROM workflow_run_admissions WHERE event_id = ? ORDER BY variant_index`,
      [eventId],
    );
  }

  /**
   * Recover from a crash scenario where jobs were enqueued into the queue
   * but the admission state was not updated.
   *
   * This method:
   * 1. Reclaims any expired claimed leases back to pending
   * 2. Claims available pending variants
   * 3. Returns the recovered variants for re-processing
   *
   * The "stable key" (event_id, variant_index) ensures no duplicate processing
   * because the primary key prevents re-insertion of the same variant.
   */
  async recoverCrash(): Promise<(WorkflowRunVariant & { token: string })[]> {
    // Step 1: Reclaim expired leases first
    await this.reclaimExpired();

    // Step 2: Claim available variants (pending or newly reclaimed)
    const recovered: Array<WorkflowRunVariant & { token: string }> = [];

    // Keep claiming while we keep getting results (handles batch recovery)
    while (true) {
      const result = await this.claimNext(30_000);
      if (!result) {
        break;
      }
      recovered.push(result);
      // If we got fewer than expected or the token indicates a single claim, stop
      // After one successful claim, continue the loop to claim more if available
    }

    return recovered;
  }
}
