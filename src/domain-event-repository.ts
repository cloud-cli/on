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

/**
 * Persists immutable, workspace-scoped event facts. Event data is ordinary JSON,
 * not encrypted; callers must restrict access and must not put secrets in it.
 */
export class DomainEventRepository {
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
