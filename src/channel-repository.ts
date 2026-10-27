import crypto from "node:crypto";
import db from "./db-client.js";

export type Channel = { id: string; teamId: string; name: string; createdAt: string };
export type ChannelMessage<T = unknown> = {
  id: string;
  teamId: string;
  channelId: string;
  threadId?: string;
  author: string;
  body: T;
  causedByEventId: string | null;
  causedByJobId: number | null;
  createdAt: string;
};
export type ChannelThread = {
  id: string;
  teamId: string;
  channelId: string;
  title: string;
  createdBy: string;
  createdAt: string;
  updatedAt: string;
};
export type Stream = { id: string; workspaceId: string; name: string; createdAt: string };
export type Thread = {
  id: string;
  workspaceId: string;
  streamId: string;
  title: string;
  createdBy: string;
  createdAt: string;
  updatedAt: string;
};

/** Channel message bodies are persisted as ordinary JSON, not encrypted. Callers must exclude secrets and credentials. */
export class ChannelRepository {
  async listStreams(workspaceId: string): Promise<Stream[]> {
    return (await this.listChannels(workspaceId)).map(({ id, teamId, name, createdAt }) => ({
      id,
      workspaceId: teamId,
      name,
      createdAt,
    }));
  }

  async getStream(workspaceId: string, streamId: string): Promise<Stream | null> {
    const stream = await this.getChannel(workspaceId, streamId);
    return stream
      ? { id: stream.id, workspaceId: stream.teamId, name: stream.name, createdAt: stream.createdAt }
      : null;
  }

  async createStream(workspaceId: string, name: string): Promise<Stream> {
    const stream = await this.createChannel(workspaceId, name);
    return { id: stream.id, workspaceId: stream.teamId, name: stream.name, createdAt: stream.createdAt };
  }

  async listStreamThreads(workspaceId: string, streamId: string): Promise<Thread[]> {
    return (await this.listThreads(workspaceId, streamId)).map((thread) => this.toThread(thread));
  }

  private toThread(thread: ChannelThread): Thread {
    return {
      id: thread.id,
      workspaceId: thread.teamId,
      streamId: thread.channelId,
      title: thread.title,
      createdBy: thread.createdBy,
      createdAt: thread.createdAt,
      updatedAt: thread.updatedAt,
    };
  }

  async listThreads(teamId: string, channelId: string): Promise<ChannelThread[]> {
    const rows = await db.all(
      `SELECT id, team_id, channel_id, title, created_by, created_at, updated_at
         FROM channel_threads WHERE team_id = ? AND channel_id = ? ORDER BY updated_at DESC, id`,
      [teamId, channelId],
    );
    return rows.map((row: any) => this.parseThread(row));
  }

  async getThread(teamId: string, channelId: string, threadId: string): Promise<ChannelThread | null> {
    const row = await db.get(
      `SELECT id, team_id, channel_id, title, created_by, created_at, updated_at
         FROM channel_threads WHERE team_id = ? AND channel_id = ? AND id = ?`,
      [teamId, channelId, threadId],
    );
    return row ? this.parseThread(row) : null;
  }

  async createThread(teamId: string, channelId: string, title: string, createdBy: string): Promise<ChannelThread> {
    const id = crypto.randomUUID();
    await db.run("INSERT INTO channel_threads (id, team_id, channel_id, title, created_by) VALUES (?, ?, ?, ?, ?)", [
      id,
      teamId,
      channelId,
      title,
      createdBy,
    ]);
    const thread = await this.getThread(teamId, channelId, id);
    if (!thread) {
      throw new Error("Thread could not be stored");
    }
    return thread;
  }

  async listThreadMessages<T = unknown>(
    teamId: string,
    channelId: string,
    threadId: string,
    limit = 50,
    after?: string,
  ): Promise<ChannelMessage<T>[]> {
    const boundedLimit = Math.max(1, Math.min(100, Math.floor(limit)));
    const rows = await db.all(
      `SELECT id, team_id, channel_id, thread_id, author, body_json, caused_by_event_id, caused_by_job_id, created_at
         FROM channel_thread_messages
        WHERE team_id = ? AND channel_id = ? AND thread_id = ?
          AND (? IS NULL OR rowid > (
            SELECT cursor.rowid FROM channel_thread_messages AS cursor
             WHERE cursor.team_id = ? AND cursor.channel_id = ? AND cursor.thread_id = ? AND cursor.id = ?
          ))
        ORDER BY rowid ASC LIMIT ?`,
      [teamId, channelId, threadId, after ?? null, teamId, channelId, threadId, after ?? "", boundedLimit],
    );
    return rows.map((row: any) => this.parse<T>(row));
  }

  async appendThreadMessage<T>(input: {
    teamId: string;
    channelId: string;
    threadId: string;
    author: string;
    body: T;
    causedByEventId?: string | null;
    causedByJobId?: number | null;
  }): Promise<ChannelMessage<T>> {
    const bodyJson = JSON.stringify(input.body);
    if (bodyJson === undefined) {
      throw new Error("Thread message body must be JSON serializable");
    }
    const id = crypto.randomUUID();
    await db.run(
      `INSERT INTO channel_thread_messages
        (id, team_id, channel_id, thread_id, author, body_json, caused_by_event_id, caused_by_job_id)
       SELECT ?, ?, ?, ?, ?, ?, ?, ? WHERE EXISTS (
         SELECT 1 FROM channel_threads WHERE team_id = ? AND channel_id = ? AND id = ?
       )`,
      [
        id,
        input.teamId,
        input.channelId,
        input.threadId,
        input.author,
        bodyJson,
        input.causedByEventId ?? null,
        input.causedByJobId ?? null,
        input.teamId,
        input.channelId,
        input.threadId,
      ],
    );
    const row = await db.get(
      `SELECT id, team_id, channel_id, thread_id, author, body_json, caused_by_event_id, caused_by_job_id, created_at
         FROM channel_thread_messages WHERE team_id = ? AND channel_id = ? AND thread_id = ? AND id = ?`,
      [input.teamId, input.channelId, input.threadId, id],
    );
    if (!row) {
      throw new Error("Thread message could not be stored");
    }
    return this.parse<T>(row);
  }

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
      ...(row.thread_id ? { threadId: row.thread_id } : {}),
      author: row.author,
      body: JSON.parse(row.body_json) as T,
      causedByEventId: row.caused_by_event_id ?? null,
      causedByJobId: row.caused_by_job_id ?? null,
      createdAt: row.created_at,
    };
  }

  private parseThread(row: any): ChannelThread {
    return {
      id: row.id,
      teamId: row.team_id,
      channelId: row.channel_id,
      title: row.title,
      createdBy: row.created_by,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    };
  }
}
