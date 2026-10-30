import crypto from "node:crypto";
import db from "./db-client.js";
import { SecretRepository } from "./secret-repository.js";

export type IncomingEventStatus = "received" | "queued" | "unmatched" | "rejected" | "failed";
export type IncomingEventValidation = "pending" | "valid" | "invalid";

export type IncomingEventSummary = {
  id: string;
  provider: string;
  deliveryId: string | null;
  eventType: string | null;
  contentType: string | null;
  receivedAt: string;
  payloadSha256: string;
  payloadBytes: number;
  validationStatus: IncomingEventValidation;
  processingStatus: IncomingEventStatus;
  queuedJobs: number;
  jobIds: number[];
  replayCount: number;
  error: string | null;
};

export type IncomingEventDetail = IncomingEventSummary & {
  payload: string;
  payloadEncoding: "utf8" | "base64";
  payloadBase64?: string;
};

/** Workspace-scoped, encrypted storage for complete inbound request bodies. */
export class IncomingEventRepository {
  constructor(private readonly secrets = new SecretRepository()) {}

  async capture(teamId: string, provider: string, headers: Record<string, string>, rawBody: Buffer): Promise<string> {
    const id = crypto.randomUUID();
    const normalizedHeaders = Object.fromEntries(
      Object.entries(headers).map(([name, value]) => [name.toLowerCase(), value]),
    );
    const deliveryId = normalizedHeaders["x-github-delivery"] || normalizedHeaders["x-delivery-id"] || null;
    const eventType =
      normalizedHeaders["x-github-event"] || normalizedHeaders["x-event-type"] || normalizedHeaders["ce-type"] || null;
    const contentType = normalizedHeaders["content-type"] || null;
    const payloadCiphertext = this.secrets.encryptValue(rawBody.toString("base64"));
    const payloadSha256 = crypto.createHash("sha256").update(rawBody).digest("hex");
    await db.run(
      `INSERT INTO incoming_events
        (id, team_id, provider, delivery_id, event_type, content_type, payload_ciphertext, payload_sha256, payload_bytes)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [id, teamId, provider, deliveryId, eventType, contentType, payloadCiphertext, payloadSha256, rawBody.length],
    );
    return id;
  }

  async receivedAtForTeam(teamId: string, id: string): Promise<string | null> {
    const row = await db.get("SELECT received_at FROM incoming_events WHERE team_id = ? AND id = ?", [teamId, id]);
    if (!row?.received_at || typeof row.received_at !== "string") {
      return null;
    }
    const value = row.received_at.includes("T") ? row.received_at : `${row.received_at.replace(" ", "T")}Z`;
    const timestamp = Date.parse(value);
    return Number.isFinite(timestamp) ? new Date(timestamp).toISOString() : null;
  }

  async finish(
    teamId: string,
    id: string,
    validation: IncomingEventValidation,
    status: IncomingEventStatus,
    inputs: unknown,
    jobIds: number[] = [],
    error: string | null = null,
  ): Promise<void> {
    const inputsCiphertext = inputs === null ? null : this.secrets.encryptValue(JSON.stringify(inputs));
    await db.run(
      `UPDATE incoming_events SET validation_status = ?, processing_status = ?, inputs_ciphertext = ?,
         queued_jobs = ?, job_ids = ?, error = ? WHERE id = ? AND team_id = ?`,
      [
        validation,
        status,
        inputsCiphertext,
        jobIds.length,
        JSON.stringify(jobIds),
        error?.slice(0, 1000) || null,
        id,
        teamId,
      ],
    );
  }

  async listForTeam(teamId: string, limit = 50, before?: string): Promise<IncomingEventSummary[]> {
    const boundedLimit = Math.max(1, Math.min(100, Math.floor(limit)));
    const rows = await db.all(
      `SELECT e.id, e.provider, e.delivery_id, e.event_type, e.content_type, e.received_at,
         e.payload_sha256, e.payload_bytes, e.validation_status, e.processing_status, e.queued_jobs,
         e.job_ids, e.error,
         (SELECT COUNT(*) FROM incoming_event_replays r WHERE r.team_id = e.team_id AND r.event_id = e.id) AS replay_count
       FROM incoming_events e
       WHERE e.team_id = ? AND (? IS NULL OR (e.received_at, e.id) < (
         SELECT received_at, id FROM incoming_events WHERE id = ? AND team_id = ?
       ))
       ORDER BY e.received_at DESC, e.id DESC LIMIT ?`,
      [teamId, before || null, before || null, teamId, boundedLimit],
    );
    return rows.map((row: any) => this.summary(row));
  }

  async getForTeam(teamId: string, id: string): Promise<(IncomingEventDetail & { inputs: any }) | null> {
    const row = await db.get(
      `SELECT e.id, e.provider, e.delivery_id, e.event_type, e.content_type, e.received_at,
         e.payload_ciphertext, e.inputs_ciphertext, e.payload_sha256, e.payload_bytes,
         e.validation_status, e.processing_status, e.queued_jobs, e.job_ids, e.error,
         (SELECT COUNT(*) FROM incoming_event_replays r WHERE r.team_id = e.team_id AND r.event_id = e.id) AS replay_count
       FROM incoming_events e WHERE e.team_id = ? AND e.id = ?`,
      [teamId, id],
    );
    if (!row) {
      return null;
    }
    const payloadBytes = Buffer.from(this.secrets.decryptValue(row.payload_ciphertext), "base64");
    const contentType = String(row.content_type || "")
      .split(";", 1)[0]
      .trim()
      .toLowerCase();
    const explicitlyText =
      contentType.startsWith("text/") ||
      contentType === "application/json" ||
      contentType.endsWith("+json") ||
      [
        "application/xml",
        "application/javascript",
        "application/x-www-form-urlencoded",
        "application/graphql",
        "application/yaml",
        "application/toml",
      ].includes(contentType);
    let textPayload: string | undefined;
    if (!contentType || explicitlyText) {
      try {
        textPayload = new TextDecoder("utf-8", { fatal: true }).decode(payloadBytes);
      } catch {
        // Preserve invalid UTF-8 byte sequences as base64 below.
      }
    }
    const payloadEncoding = textPayload === undefined ? "base64" : "utf8";
    const inputs = row.inputs_ciphertext ? JSON.parse(this.secrets.decryptValue(row.inputs_ciphertext)) : null;
    return {
      ...this.summary(row),
      payload: textPayload ?? "",
      payloadEncoding,
      ...(payloadEncoding === "base64" ? { payloadBase64: payloadBytes.toString("base64") } : {}),
      inputs,
    };
  }

  async createReplay(teamId: string, eventId: string, actor: string): Promise<string> {
    const id = crypto.randomUUID();
    await db.run(
      "INSERT INTO incoming_event_replays (id, event_id, team_id, actor) SELECT ?, id, ?, ? FROM incoming_events WHERE id = ? AND team_id = ?",
      [id, teamId, actor, eventId, teamId],
    );
    const exists = await db.get("SELECT id FROM incoming_event_replays WHERE id = ? AND team_id = ?", [id, teamId]);
    if (!exists) {
      throw new Error("Incoming event not found");
    }
    return id;
  }

  async finishReplay(
    teamId: string,
    replayId: string,
    status: "queued" | "unmatched" | "failed",
    jobIds: number[] = [],
    error: string | null = null,
  ): Promise<void> {
    await db.run(
      `UPDATE incoming_event_replays SET status = ?, queued_jobs = ?, job_ids = ?, error = ?
       WHERE team_id = ? AND id = ?`,
      [status, jobIds.length, JSON.stringify(jobIds), error?.slice(0, 1000) || null, teamId, replayId],
    );
  }

  private summary(row: any): IncomingEventSummary {
    let jobIds: unknown;
    try {
      jobIds = JSON.parse(row.job_ids || "[]");
    } catch {
      jobIds = [];
    }
    return {
      id: row.id,
      provider: row.provider,
      deliveryId: row.delivery_id || null,
      eventType: row.event_type || null,
      contentType: row.content_type || null,
      receivedAt: row.received_at,
      payloadSha256: row.payload_sha256,
      payloadBytes: Number(row.payload_bytes || 0),
      validationStatus: row.validation_status,
      processingStatus: row.processing_status,
      queuedJobs: Number(row.queued_jobs || 0),
      jobIds: Array.isArray(jobIds) ? jobIds.filter((value): value is number => Number.isSafeInteger(value)) : [],
      replayCount: Number(row.replay_count || 0),
      error: row.error || null,
    };
  }
}
