import crypto from "node:crypto";
import db from "./db-client.js";

const serializeJson = (value: unknown): string | undefined =>
  JSON.stringify(value, (_key, nested) => {
    if (nested && typeof nested === "object" && !Array.isArray(nested)) {
      return Object.fromEntries(Object.entries(nested).sort(([left], [right]) => left.localeCompare(right)));
    }
    return nested;
  });

export type DomainEvent<T = unknown> = {
  id: string;
  teamId: string;
  type: string;
  schemaVersion: number;
  source: string;
  occurredAt: string;
  recordedAt: string;
  correlationId: string | null;
  causationId: string | null;
  idempotencyKey: string | null;
  data: T;
};

export type PublishDomainEvent<T> = Omit<DomainEvent<T>, "id" | "teamId" | "recordedAt"> & {
  id?: string;
};

export type DomainEventPage<T = unknown> = {
  events: DomainEvent<T>[];
  nextCursor: string | null;
  resumeCursor: string | null;
};

function encodeSequenceCursor(teamId: string, channelId: string, sequence: number): string {
  return Buffer.from(JSON.stringify({ v: 1, teamId, channelId, sequence })).toString("base64url");
}

export type WorkflowRunRequest<T = unknown> = DomainEvent<T> & {
  sequence: number;
};

export type DomainEventLinks = {
  messageIds: string[];
  invocationIds: string[];
  runIds: string[];
  causationEventId: string | null;
};

export type WorkflowInvocationView = {
  id: string;
  teamId: string;
  requestEventId: string;
  workflowId: string;
  revision: number;
  recordedAt: string;
  variants: Array<{
    variantIndex: number;
    admissionStatus: string;
    admissionOutcome: string | null;
    errorCode: string | null;
    runId: string | null;
  }>;
};

/**
 * Persists immutable, workspace-scoped event facts. Event data is ordinary JSON,
 * not encrypted; callers must restrict access and must not put secrets in it.
 */
export class DomainEventRepository {
  /** Returns invocation admission and run references without exposing request inputs. */
  async getWorkflowInvocationForTeam(teamId: string, invocationId: string): Promise<WorkflowInvocationView | null> {
    const event = await db.get(
      `SELECT id, team_id, recorded_at,
              CASE WHEN json_valid(data_json) THEN json_extract(data_json, '$.workflowId') END AS workflow_id,
              CASE WHEN json_valid(data_json) THEN json_extract(data_json, '$.revision') END AS revision,
              CASE WHEN json_valid(data_json) THEN json_extract(data_json, '$.invocationId') END AS invocation_id
         FROM domain_events
        WHERE team_id = ? AND type = 'workflow.run.requested'
          AND (id = ? OR CASE WHEN json_valid(data_json) THEN json_extract(data_json, '$.invocationId') END = ?)
        ORDER BY CASE WHEN id = ? THEN 0 ELSE 1 END LIMIT 1`,
      [teamId, invocationId, invocationId, invocationId],
    );
    const revision = Number(event?.revision);
    if (!event || typeof event.workflow_id !== "string" || !Number.isInteger(revision) || revision < 1) {
      return null;
    }
    const rows = await db.all(
      `SELECT a.variant_index, a.status AS admission_status, a.admission_outcome, a.error_code, a.job_id
         FROM workflow_run_admissions a
        WHERE a.team_id = ? AND a.event_id = ?
        ORDER BY a.variant_index`,
      [teamId, event.id],
    );
    return {
      id: String(event.invocation_id || event.id),
      teamId: String(event.team_id),
      requestEventId: String(event.id),
      workflowId: event.workflow_id,
      revision,
      recordedAt: String(event.recorded_at),
      variants: rows.map((row: any) => ({
        variantIndex: Number(row.variant_index),
        admissionStatus: String(row.admission_status),
        admissionOutcome:
          row.admission_outcome === null || row.admission_outcome === undefined
            ? row.admission_status === "admitted"
              ? "accepted"
              : null
            : String(row.admission_outcome),
        errorCode: row.error_code === null || row.error_code === undefined ? null : String(row.error_code),
        runId: row.job_id === null || row.job_id === undefined ? null : String(row.job_id),
      })),
    };
  }

  async listChannelEvents<T = unknown>(
    teamId: string,
    channelId: string,
    limit = 50,
    cursor?: string,
  ): Promise<DomainEventPage<T>> {
    const boundedLimit = Math.max(1, Math.min(100, Math.floor(limit)));
    let afterSequence = 0;
    if (cursor !== undefined) {
      let decoded: unknown;
      try {
        decoded = JSON.parse(Buffer.from(cursor, "base64url").toString("utf8"));
      } catch {
        throw new Error("Invalid event cursor");
      }
      if (
        !decoded ||
        typeof decoded !== "object" ||
        (decoded as any).v !== 1 ||
        (decoded as any).teamId !== teamId ||
        (decoded as any).channelId !== channelId ||
        !Number.isSafeInteger((decoded as any).sequence) ||
        (decoded as any).sequence < 1
      ) {
        throw new Error("Invalid event cursor");
      }
      afterSequence = (decoded as any).sequence;
    }
    const rows = await db.all(
      `SELECT e.sequence, e.id, e.team_id, e.type, e.schema_version, e.source, e.occurred_at, e.recorded_at,
              e.correlation_id, e.causation_id, e.idempotency_key, e.data_json
         FROM domain_events e
         JOIN stream_event_bindings b ON b.team_id = e.team_id AND b.event_id = e.id
        WHERE e.team_id = ? AND b.stream_id = ? AND e.sequence > ?
        ORDER BY e.sequence LIMIT ?`,
      [teamId, channelId, afterSequence, boundedLimit + 1],
    );
    const hasMore = rows.length > boundedLimit;
    const pageRows = hasMore ? rows.slice(0, boundedLimit) : rows;
    const last = pageRows.at(-1);
    const nextCursor = hasMore && last ? encodeSequenceCursor(teamId, channelId, Number(last.sequence)) : null;
    const events = await Promise.all(
      pageRows.map(async (row: any) => {
        const event = this.parse<T>(row);
        const messages = await db.all(
          `SELECT id FROM channel_messages
         WHERE team_id = ? AND channel_id = ? AND caused_by_event_id = ? ORDER BY rowid`,
          [teamId, channelId, event.id],
        );
        const runs = await db.all(
          `SELECT DISTINCT CAST(COALESCE(j.value, a.job_id) AS TEXT) AS id
           FROM domain_event_deliveries d
           LEFT JOIN domain_events invocation_event
             ON invocation_event.team_id = d.team_id AND invocation_event.type = 'workflow.run.requested'
            AND (invocation_event.id = d.invocation_id OR
                 (json_valid(invocation_event.data_json) AND
                  json_extract(invocation_event.data_json, '$.invocationId') = d.invocation_id))
           LEFT JOIN workflow_run_admissions a ON a.event_id = invocation_event.id AND a.team_id = d.team_id
           LEFT JOIN json_each(CASE WHEN json_valid(d.job_ids_json) THEN d.job_ids_json ELSE '[]' END) j
          WHERE d.team_id = ? AND d.event_id = ? AND d.status = 'admitted'
            AND (j.value IS NOT NULL OR a.job_id IS NOT NULL)
          ORDER BY id`,
          [teamId, event.id],
        );
        const invocations = await db.all(
          `SELECT DISTINCT invocation_id AS id FROM domain_event_deliveries
            WHERE team_id = ? AND event_id = ? AND status = 'admitted' AND invocation_id IS NOT NULL
            ORDER BY invocation_id`,
          [teamId, event.id],
        );
        const causationEventId =
          event.causationId && (await this.getForTeam(teamId, event.causationId)) ? event.causationId : null;
        return {
          ...event,
          links: {
            messageIds: messages.map((message: any) => String(message.id)),
            invocationIds: invocations.map((invocation: any) => String(invocation.id)),
            runIds: runs.map((run: any) => String(run.id)),
            causationEventId,
          },
        };
      }),
    );
    return {
      events,
      nextCursor,
      resumeCursor: last ? encodeSequenceCursor(teamId, channelId, Number(last.sequence)) : cursor || null,
    };
  }

  /** Bind a canonical event to a workspace Stream without copying or redispatching it. */
  async bindEventToStream(teamId: string, streamId: string, eventId: string): Promise<boolean> {
    const result = await db.run(
      `INSERT OR IGNORE INTO stream_event_bindings (team_id, stream_id, event_id)
       SELECT e.team_id, c.id, e.id
         FROM domain_events e JOIN channels c ON c.team_id = e.team_id
        WHERE e.team_id = ? AND c.id = ? AND e.id = ?`,
      [teamId, streamId, eventId],
    );
    if (Number(result?.changes || 0) === 1) {
      return true;
    }
    return Boolean(
      await db.get(
        "SELECT 1 AS bound FROM stream_event_bindings WHERE team_id = ? AND stream_id = ? AND event_id = ?",
        [teamId, streamId, eventId],
      ),
    );
  }

  async publish<T>(teamId: string, event: PublishDomainEvent<T>): Promise<DomainEvent<T>> {
    const id = event.id || crypto.randomUUID();
    const recordedAt = new Date().toISOString();
    const dataJson = serializeJson(event.data);
    if (dataJson === undefined) {
      throw new Error("Domain event data must be JSON serializable");
    }
    await db.run(
      `INSERT OR IGNORE INTO domain_events
        (id, team_id, type, schema_version, source, occurred_at, recorded_at,
         correlation_id, causation_id, idempotency_key, data_json)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        id,
        teamId,
        event.type,
        event.schemaVersion,
        event.source,
        event.occurredAt,
        recordedAt,
        event.correlationId,
        event.causationId,
        event.idempotencyKey,
        dataJson,
      ],
    );
    if (event.idempotencyKey !== null) {
      const existing = await db.get(
        `SELECT id, team_id, type, schema_version, source, occurred_at, recorded_at,
                correlation_id, causation_id, idempotency_key, data_json
         FROM domain_events WHERE team_id = ? AND idempotency_key = ?`,
        [teamId, event.idempotencyKey],
      );
      if (existing) {
        this.assertSameEvent(existing, event, dataJson);
        return this.parse<T>(existing);
      }
    }
    const row = await db.get(
      `SELECT id, team_id, type, schema_version, source, occurred_at, recorded_at,
              correlation_id, causation_id, idempotency_key, data_json
       FROM domain_events WHERE team_id = ? AND id = ?`,
      [teamId, id],
    );
    if (!row) {
      throw new Error("Domain event could not be stored");
    }
    this.assertSameEvent(row, event, dataJson);
    return this.parse<T>(row);
  }

  private assertSameEvent(row: any, event: PublishDomainEvent<unknown>, dataJson: string): void {
    if (
      row.type !== event.type ||
      Number(row.schema_version) !== event.schemaVersion ||
      row.source !== event.source ||
      row.occurred_at !== event.occurredAt ||
      (row.idempotency_key ?? null) !== event.idempotencyKey ||
      (row.correlation_id ?? null) !== event.correlationId ||
      (row.causation_id ?? null) !== event.causationId ||
      serializeJson(JSON.parse(row.data_json)) !== dataJson
    ) {
      throw new Error("Domain event idempotency key conflicts with an existing event");
    }
  }

  async getForTeam<T = unknown>(teamId: string, id: string): Promise<DomainEvent<T> | null> {
    const row = await db.get(
      `SELECT id, team_id, type, schema_version, source, occurred_at, recorded_at,
              correlation_id, causation_id, idempotency_key, data_json
       FROM domain_events WHERE team_id = ? AND id = ?`,
      [teamId, id],
    );
    return row ? this.parse<T>(row) : null;
  }

  async getByIdempotencyKey<T = unknown>(teamId: string, idempotencyKey: string): Promise<DomainEvent<T> | null> {
    const row = await db.get(
      `SELECT id, team_id, type, schema_version, source, occurred_at, recorded_at,
              correlation_id, causation_id, idempotency_key, data_json
       FROM domain_events WHERE team_id = ? AND idempotency_key = ?`,
      [teamId, idempotencyKey],
    );
    return row ? this.parse<T>(row) : null;
  }

  async listForTeam<T = unknown>(teamId: string, limit = 50): Promise<DomainEvent<T>[]> {
    const boundedLimit = Math.max(1, Math.min(100, Math.floor(limit)));
    const rows = await db.all(
      `SELECT id, team_id, type, schema_version, source, occurred_at, recorded_at,
              correlation_id, causation_id, idempotency_key, data_json
       FROM domain_events WHERE team_id = ? ORDER BY recorded_at DESC, id DESC LIMIT ?`,
      [teamId, boundedLimit],
    );
    return rows.map((row: any) => this.parse<T>(row));
  }

  async listWorkflowRunRequests<T = unknown>(
    limit = 100,
    offset = 0,
    cursorSequence?: number,
  ): Promise<WorkflowRunRequest<T>[]> {
    const boundedLimit = Math.max(1, Math.min(500, Math.floor(limit)));
    const whereBase = `FROM domain_events WHERE type = 'workflow.run.requested'
      AND (source = 'api/workflows/run' OR source LIKE 'domain-event-delivery/%' OR source = 'runner/workflow-dispatch')`;
    if (cursorSequence != null) {
      const rows = await db.all(
        `SELECT sequence, id, team_id, type, schema_version, source, occurred_at, recorded_at,
        correlation_id, causation_id, idempotency_key, data_json ${whereBase} AND sequence > ? ORDER BY sequence LIMIT ?`,
        [cursorSequence, boundedLimit],
      );
      return rows.map((row: any) => ({
        ...this.parse<T>(row),
        sequence: Number(row.sequence),
      }));
    }
    if (offset > 0) {
      const rows = await db.all(
        `SELECT sequence, id, team_id, type, schema_version, source, occurred_at, recorded_at,
        correlation_id, causation_id, idempotency_key, data_json ${whereBase} ORDER BY sequence LIMIT ? OFFSET ?`,
        [boundedLimit, offset],
      );
      return rows.map((row: any) => ({
        ...this.parse<T>(row),
        sequence: Number(row.sequence),
      }));
    }
    const rows = await db.all(
      `SELECT sequence, id, team_id, type, schema_version, source, occurred_at, recorded_at,
      correlation_id, causation_id, idempotency_key, data_json ${whereBase} ORDER BY sequence LIMIT ?`,
      [boundedLimit],
    );
    return rows.map((row: any) => ({
      ...this.parse<T>(row),
      sequence: Number(row.sequence),
    }));
  }

  private parse<T>(row: any): DomainEvent<T> {
    return {
      id: row.id,
      teamId: row.team_id,
      type: row.type,
      schemaVersion: Number(row.schema_version),
      source: row.source,
      occurredAt: row.occurred_at,
      recordedAt: row.recorded_at,
      correlationId: row.correlation_id ?? null,
      causationId: row.causation_id ?? null,
      idempotencyKey: row.idempotency_key ?? null,
      data: JSON.parse(row.data_json) as T,
    };
  }
}
