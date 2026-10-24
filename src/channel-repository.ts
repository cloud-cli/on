import crypto from "node:crypto";
import db from "./db-client.js";

export type Channel = { id: string; teamId: string; name: string; createdAt: string };
export type ChannelMessage<T = unknown> = {
  id: string;
  teamId: string;
  channelId: string;
  author: string;
  body: T;
  causedByEventId: string | null;
  causedByJobId: number | null;
  createdAt: string;
};

/** Channel message bodies are persisted as ordinary JSON, not encrypted. Callers must exclude secrets and credentials. */
export class ChannelRepository {
  async listChannels(teamId: string): Promise<Channel[]> {
    const rows = await db.all(
      "SELECT id, team_id, name, created_at FROM channels WHERE team_id = ? ORDER BY created_at, id",
      [teamId],
    );
    return rows.map((row: any) => ({ id: row.id, teamId: row.team_id, name: row.name, createdAt: row.created_at }));
  }

  async getChannel(teamId: string, channelId: string): Promise<Channel | null> {
    const row = await db.get("SELECT id, team_id, name, created_at FROM channels WHERE team_id = ? AND id = ?", [
      teamId,
      channelId,
    ]);
    return row ? { id: row.id, teamId: row.team_id, name: row.name, createdAt: row.created_at } : null;
  }

  async createChannel(teamId: string, name: string, id = crypto.randomUUID()): Promise<Channel> {
    await db.run("INSERT INTO channels (id, team_id, name) VALUES (?, ?, ?)", [id, teamId, name]);
    const row = await db.get("SELECT id, team_id, name, created_at FROM channels WHERE team_id = ? AND id = ?", [
      teamId,
      id,
    ]);
    if (!row) {
      throw new Error("Channel could not be stored");
    }
    return { id: row.id, teamId: row.team_id, name: row.name, createdAt: row.created_at };
  }

  async appendMessage<T>(input: {
    teamId: string;
    channelId: string;
    author: string;
    body: T;
    causedByEventId?: string | null;
    causedByJobId?: number | null;
  }): Promise<ChannelMessage<T>> {
    const bodyJson = JSON.stringify(input.body);
    if (bodyJson === undefined) {
      throw new Error("Channel message body must be JSON serializable");
    }
    const id = crypto.randomUUID();
    await db.run(
      `INSERT INTO channel_messages
        (id, team_id, channel_id, author, body_json, caused_by_event_id, caused_by_job_id)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
      [
        id,
        input.teamId,
        input.channelId,
        input.author,
        bodyJson,
        input.causedByEventId ?? null,
        input.causedByJobId ?? null,
      ],
    );
    const row = await db.get(
      `SELECT id, team_id, channel_id, author, body_json, caused_by_event_id, caused_by_job_id, created_at
       FROM channel_messages WHERE team_id = ? AND channel_id = ? AND id = ?`,
      [input.teamId, input.channelId, id],
    );
    if (!row) {
      throw new Error("Channel message could not be stored");
    }
    return this.parse<T>(row);
  }

  /** Returns ascending history. `after` is an opaque message ID; the cursor is always resolved inside the requested team/channel. */
  async listMessages<T = unknown>(
    teamId: string,
    channelId: string,
    limit = 50,
    after?: string,
  ): Promise<ChannelMessage<T>[]> {
    const boundedLimit = Math.max(1, Math.min(100, Math.floor(limit)));
    const rows = await db.all(
      `SELECT id, team_id, channel_id, author, body_json, caused_by_event_id, caused_by_job_id, created_at
       FROM channel_messages
       WHERE team_id = ? AND channel_id = ?
          AND (? IS NULL OR rowid > (
            SELECT cursor.rowid FROM channel_messages AS cursor
            WHERE cursor.team_id = ? AND cursor.channel_id = ? AND cursor.id = ?
          ))
        ORDER BY rowid ASC LIMIT ?`,
      [teamId, channelId, after ?? null, teamId, channelId, after ?? "", boundedLimit],
    );
    return rows.map((row: any) => this.parse<T>(row));
  }

  private parse<T>(row: any): ChannelMessage<T> {
    return {
      id: row.id,
      teamId: row.team_id,
      channelId: row.channel_id,
      author: row.author,
      body: JSON.parse(row.body_json) as T,
      causedByEventId: row.caused_by_event_id ?? null,
      causedByJobId: row.caused_by_job_id ?? null,
      createdAt: row.created_at,
    };
  }
}
