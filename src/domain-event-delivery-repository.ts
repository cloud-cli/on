import crypto from "node:crypto";
import db from "./db-client.js";

/** Maximum times a delivery may be claimed before it can no longer be retried. */
export const MAX_DELIVERY_ATTEMPTS = 12;

export type EventSubscription = {
  id: string;
  teamId: string;
  workflowId: string;
  workflowRevision: number;
  eventType: string;
  enabled: boolean;
  createdAt: string;
};

export type EventDelivery = {
  id: string;
  teamId: string;
  eventId: string;
  subscriptionId: string;
  status: "pending" | "claimed" | "admitted" | "filtered" | "failed";
  attemptCount: number;
  leaseUntil: string | null;
  jobIds: string[];
  lastError: string | null;
  createdAt: string;
  updatedAt: string;
};

export class DomainEventDeliveryRepository {
  async getForTeam(teamId: string, subscriptionId: string): Promise<EventSubscription | null> {
    const row = await db.get("SELECT * FROM domain_event_subscriptions WHERE team_id = ? AND id = ?", [
      teamId,
      subscriptionId,
    ]);
    return row ? this.parseSubscription(row) : null;
  }

  async listForEvent(teamId: string, eventId: string): Promise<EventDelivery[]> {
    const rows = await db.all(
      `SELECT * FROM domain_event_deliveries
       WHERE team_id = ? AND event_id = ? ORDER BY created_at, id`,
      [teamId, eventId],
    );
    return rows.map((row: any) => this.parseDelivery(row));
  }

  async retryFailed(teamId: string, deliveryId: string): Promise<EventDelivery | null> {
    const row = await db.get(
      `UPDATE domain_event_deliveries
       SET status = 'pending', attempt_count = 0, lease_until = NULL, last_error = NULL,
           updated_at = CURRENT_TIMESTAMP
       WHERE team_id = ? AND id = ? AND status = 'failed'
       RETURNING *`,
      [teamId, deliveryId],
    );
    return row ? this.parseDelivery(row) : null;
  }

  async createSubscription(
    teamId: string,
    input: Pick<EventSubscription, "workflowId" | "workflowRevision" | "eventType"> & { id?: string },
  ): Promise<EventSubscription> {
    const workflow = await db.get("SELECT 1 AS present FROM workflows WHERE team_id = ? AND id = ?", [
      teamId,
      input.workflowId,
    ]);
    if (!workflow) {
      throw new Error("Workflow not found for team");
    }
    const id = input.id || crypto.randomUUID();
    await db.run(
      `INSERT OR IGNORE INTO domain_event_subscriptions
         (id, team_id, workflow_id, workflow_revision, event_type, high_water_event_sequence)
       VALUES (?, ?, ?, ?, ?, (SELECT COALESCE(MAX(sequence), 0) FROM domain_events WHERE team_id = ?))`,
      [id, teamId, input.workflowId, input.workflowRevision, input.eventType, teamId],
    );
    const row = await db.get(
      `SELECT * FROM domain_event_subscriptions
       WHERE team_id = ? AND workflow_id = ? AND workflow_revision = ? AND event_type = ?`,
      [teamId, input.workflowId, input.workflowRevision, input.eventType],
    );
    if (!row) {
      throw new Error("Subscription could not be stored");
    }
    return this.parseSubscription(row);
  }

  async listSubscriptions(teamId: string): Promise<EventSubscription[]> {
    const rows = await db.all("SELECT * FROM domain_event_subscriptions WHERE team_id = ? ORDER BY created_at, id", [
      teamId,
    ]);
    return rows.map((row: any) => this.parseSubscription(row));
  }

  /** Creates only deliveries for subscriptions active when the event was recorded. */
  async fanout(teamId: string, eventId: string): Promise<number> {
    const event = await db.get("SELECT sequence, type FROM domain_events WHERE team_id = ? AND id = ?", [
      teamId,
      eventId,
    ]);
    if (!event) {
      throw new Error("Event not found for team");
    }
    await db.run(
      `INSERT OR IGNORE INTO domain_event_deliveries (id, team_id, event_id, subscription_id)
       SELECT lower(hex(randomblob(16))), ?, ?, s.id FROM domain_event_subscriptions s
       WHERE s.team_id = ? AND s.event_type = ? AND s.enabled = 1
           AND ? > s.high_water_event_sequence`,
      [teamId, eventId, teamId, event.type, event.sequence],
    );
    const count = await db.get(
      "SELECT COUNT(*) AS count FROM domain_event_deliveries WHERE team_id = ? AND event_id = ?",
      [teamId, eventId],
    );
    return Number(count?.count ?? 0);
  }

  /** Repairs the publish/fanout crash window without backfilling pre-subscription events. */
  async reconcileFanout(limit = 100): Promise<number> {
    const boundedLimit = Math.max(1, Math.min(500, Math.floor(limit)));
    const result = await db.run(
      `INSERT OR IGNORE INTO domain_event_deliveries (id, team_id, event_id, subscription_id)
       SELECT lower(hex(randomblob(16))), s.team_id, e.id, s.id
       FROM domain_events e JOIN domain_event_subscriptions s ON s.team_id = e.team_id
        WHERE s.enabled = 1 AND s.event_type = e.type AND e.sequence > s.high_water_event_sequence
         AND NOT EXISTS (
           SELECT 1 FROM domain_event_deliveries d
           WHERE d.team_id = s.team_id AND d.event_id = e.id AND d.subscription_id = s.id
         )
        ORDER BY e.sequence LIMIT ?`,
      [boundedLimit],
    );
    return Number(result?.changes ?? 0);
  }

  /** Atomic one-row claim; work is performed by the caller after this statement returns. */
  async claimNext(teamId: string, leaseMilliseconds = 60_000): Promise<EventDelivery | null> {
    await this.failExhaustedClaims(teamId);
    const leaseUntil = new Date(Date.now() + Math.max(1, leaseMilliseconds)).toISOString();
    const row = await db.get(
      `UPDATE domain_event_deliveries
       SET status = 'claimed', attempt_count = attempt_count + 1, lease_until = ?, updated_at = CURRENT_TIMESTAMP
       WHERE team_id = ? AND id = (
         SELECT id FROM domain_event_deliveries
           WHERE team_id = ? AND attempt_count < ${MAX_DELIVERY_ATTEMPTS}
             AND ((status = 'pending' AND (lease_until IS NULL OR julianday(lease_until) <= julianday('now')))
               OR (status = 'claimed' AND julianday(lease_until) <= julianday('now')))
         ORDER BY created_at, id LIMIT 1
        ) AND attempt_count < ${MAX_DELIVERY_ATTEMPTS}
           AND ((status = 'pending' AND (lease_until IS NULL OR julianday(lease_until) <= julianday('now')))
             OR (status = 'claimed' AND julianday(lease_until) <= julianday('now')))
       RETURNING *`,
      [leaseUntil, teamId, teamId],
    );
    return row ? this.parseDelivery(row) : null;
  }

  async claimNextAny(leaseMilliseconds = 60_000): Promise<EventDelivery | null> {
    await this.failExhaustedClaims();
    const leaseUntil = new Date(Date.now() + Math.max(1, leaseMilliseconds)).toISOString();
    const row = await db.get(
      `UPDATE domain_event_deliveries
       SET status = 'claimed', attempt_count = attempt_count + 1, lease_until = ?, updated_at = CURRENT_TIMESTAMP
       WHERE id = (SELECT id FROM domain_event_deliveries
          WHERE attempt_count < ${MAX_DELIVERY_ATTEMPTS}
             AND ((status = 'pending' AND (lease_until IS NULL OR julianday(lease_until) <= julianday('now')))
               OR (status = 'claimed' AND julianday(lease_until) <= julianday('now')))
         ORDER BY created_at, id LIMIT 1)
        AND attempt_count < ${MAX_DELIVERY_ATTEMPTS}
        AND ((status = 'pending' AND (lease_until IS NULL OR julianday(lease_until) <= julianday('now')))
          OR (status = 'claimed' AND julianday(lease_until) <= julianday('now')))
       RETURNING *`,
      [leaseUntil],
    );
    return row ? this.parseDelivery(row) : null;
  }

  async finish(
    teamId: string,
    deliveryId: string,
    expectedAttemptCount: number,
    result: {
      status: "admitted" | "filtered" | "failed" | "pending";
      jobIds?: string[];
      error?: string | null;
    },
  ): Promise<EventDelivery | null> {
    const status =
      result.status === "pending" && expectedAttemptCount >= MAX_DELIVERY_ATTEMPTS ? "failed" : result.status;
    const retryDelayMs = Math.min(60_000, 1000 * 2 ** Math.max(0, expectedAttemptCount - 1));
    const leaseUntil = status === "pending" ? new Date(Date.now() + retryDelayMs).toISOString() : null;
    const row = await db.get(
      `UPDATE domain_event_deliveries
       SET status = ?, lease_until = ?, job_ids_json = ?, last_error = ?, updated_at = CURRENT_TIMESTAMP
       WHERE team_id = ? AND id = ? AND status = 'claimed' AND attempt_count = ?
       RETURNING *`,
      [
        status,
        leaseUntil,
        JSON.stringify(result.jobIds ?? []),
        result.error ?? null,
        teamId,
        deliveryId,
        expectedAttemptCount,
      ],
    );
    return row ? this.parseDelivery(row) : null;
  }

  private async failExhaustedClaims(teamId?: string): Promise<void> {
    await db.run(
      `UPDATE domain_event_deliveries
       SET status = 'failed', lease_until = NULL, last_error = 'Delivery attempts exhausted', updated_at = CURRENT_TIMESTAMP
       WHERE status = 'claimed' AND attempt_count >= ${MAX_DELIVERY_ATTEMPTS}
         AND julianday(lease_until) <= julianday('now')${teamId ? " AND team_id = ?" : ""}`,
      teamId ? [teamId] : [],
    );
  }

  private parseSubscription(row: any): EventSubscription {
    return {
      id: row.id,
      teamId: row.team_id,
      workflowId: row.workflow_id,
      workflowRevision: Number(row.workflow_revision),
      eventType: row.event_type,
      enabled: Boolean(row.enabled),
      createdAt: row.created_at,
    };
  }

  private parseDelivery(row: any): EventDelivery {
    return {
      id: row.id,
      teamId: row.team_id,
      eventId: row.event_id,
      subscriptionId: row.subscription_id,
      status: row.status,
      attemptCount: Number(row.attempt_count),
      leaseUntil: row.lease_until ?? null,
      jobIds: JSON.parse(row.job_ids_json),
      lastError: row.last_error ?? null,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    };
  }
}
