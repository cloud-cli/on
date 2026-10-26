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
};

export type WorkflowRunRequest<T = unknown> = DomainEvent<T> & {
  sequence: number;
};

export type DomainEventLinks = {
  messageIds: string[];
  runIds: string[];
  causationEventId: string | null;
};

/**
 * Persists immutable, workspace-scoped event facts. Event data is ordinary JSON,
 * not encrypted; callers must restrict access and must not put secrets in it.
 */
export class DomainEventRepository {
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
      `SELECT sequence, id, team_id, type, schema_version, source, occurred_at, recorded_at,
              correlation_id, causation_id, idempotency_key, data_json
       FROM domain_events
        WHERE team_id = ? AND json_extract(data_json, '$.channelId') = ? AND sequence > ?
        ORDER BY sequence LIMIT ?`,
      [teamId, channelId, afterSequence, boundedLimit + 1],
    );
    const hasMore = rows.length > boundedLimit;
    const pageRows = hasMore ? rows.slice(0, boundedLimit) : rows;
    const last = pageRows.at(-1);
    const nextCursor =
      hasMore && last
        ? Buffer.from(
            JSON.stringify({
              v: 1,
              teamId,
              channelId,
              sequence: Number(last.sequence),
            }),
          ).toString("base64url")
        : null;
    const events = await Promise.all(
      pageRows.map(async (row: any) => {
        const event = this.parse<T>(row);
        const messages = await db.all(
          `SELECT id FROM channel_messages
         WHERE team_id = ? AND channel_id = ? AND caused_by_event_id = ? ORDER BY rowid`,
          [teamId, channelId, event.id],
        );
        const runs = await db.all(
          `SELECT DISTINCT j.value AS id FROM domain_event_deliveries d,
           json_each(CASE WHEN json_valid(d.job_ids_json) THEN d.job_ids_json ELSE '[]' END) j
         WHERE d.team_id = ? AND d.event_id = ? AND d.status = 'admitted'
         ORDER BY j.value`,
          [teamId, event.id],
        );
        const causationEventId =
          event.causationId && (await this.getForTeam(teamId, event.causationId)) ? event.causationId : null;
        return {
          ...event,
          links: {
            messageIds: messages.map((message: any) => String(message.id)),
            runIds: runs.map((run: any) => String(run.id)),
            causationEventId,
          },
        };
      }),
    );
    return { events, nextCursor };
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
    const whereBase = `FROM domain_events WHERE type = 'workflow.run.requested' AND source = 'api/workflows/run'`;
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
