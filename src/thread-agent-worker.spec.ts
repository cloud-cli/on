import { DatabaseSync } from "node:sqlite";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createHash } from "node:crypto";

const mockCreate = vi.hoisted(() => vi.fn());
const database = vi.hoisted(() => ({ all: vi.fn(), get: vi.fn(), run: vi.fn(), transaction: vi.fn() }));
vi.mock("openai", () => ({
  default: class {
    chat = { completions: { create: mockCreate } };
  },
}));
vi.mock("./db-client.js", () => ({ default: database }));

import { ThreadAgentRepository } from "./thread-agents.js";

const repository = new ThreadAgentRepository();
const params = (values: unknown[] = []) => values as import("node:sqlite").SQLInputValue[];
const providerNotice = "notice";
const originalEnvironment = {
  OPENAI_API_URL: process.env.OPENAI_API_URL,
  OPENAI_API_MODEL: process.env.OPENAI_API_MODEL,
  OPENAI_API_KEY: process.env.OPENAI_API_KEY,
  THREAD_AGENT_PROVIDER_NOTICE: process.env.THREAD_AGENT_PROVIDER_NOTICE,
};
let connection: DatabaseSync;

function fingerprint() {
  return createHash("sha256")
    .update(JSON.stringify(["https://provider.example/v1", "model-a"]))
    .digest("hex");
}

function insertMessage(id: string, threadId: string, author: string, body: unknown) {
  connection
    .prepare(
      `INSERT INTO channel_thread_messages(id,team_id,channel_id,thread_id,author,body_json)
    VALUES(?, 'team','stream',?,?,?)`,
    )
    .run(id, threadId, author, JSON.stringify(body));
}

function insertTurn() {
  connection
    .prepare(
      `INSERT INTO thread_agent_turns(id,team_id,stream_id,thread_id,subscription_id,source_message_id,
    status,attempt_count,lease_token,fence) VALUES('turn','team','stream','thread','sub','source','claimed',1,'token',1)`,
    )
    .run();
}

beforeEach(() => {
  process.env.OPENAI_API_URL = "https://provider.example/v1";
  process.env.OPENAI_API_MODEL = "model-a";
  process.env.OPENAI_API_KEY = "test-key";
  process.env.THREAD_AGENT_PROVIDER_NOTICE = providerNotice;
  mockCreate.mockReset();
  connection = new DatabaseSync(":memory:");
  connection.exec(`
    PRAGMA foreign_keys=ON;
    CREATE TABLE channel_threads(team_id TEXT,channel_id TEXT,id TEXT,PRIMARY KEY(team_id,channel_id,id));
    CREATE TABLE channel_thread_messages(id TEXT PRIMARY KEY,team_id TEXT,channel_id TEXT,thread_id TEXT,author TEXT,
      body_json TEXT,caused_by_event_id TEXT,caused_by_job_id TEXT,created_at TEXT DEFAULT CURRENT_TIMESTAMP,UNIQUE(team_id,id));
    CREATE TABLE oidc_users(subject TEXT PRIMARY KEY,kind TEXT,disabled_at TEXT,name TEXT);
    CREATE TABLE team_members(team_id TEXT,subject TEXT,PRIMARY KEY(team_id,subject));
    CREATE TABLE thread_agent_subscriptions(id TEXT PRIMARY KEY,team_id TEXT,stream_id TEXT,thread_id TEXT,
      agent_principal_id TEXT,consent_actor TEXT,consented_at TEXT,disclosure_version TEXT,provider_notice TEXT,
      provider_fingerprint TEXT,enabled INTEGER DEFAULT 1,fence INTEGER DEFAULT 1,created_at TEXT DEFAULT CURRENT_TIMESTAMP,
      disabled_at TEXT,UNIQUE(team_id,id));
    CREATE TABLE thread_agent_turns(id TEXT PRIMARY KEY,team_id TEXT,stream_id TEXT,thread_id TEXT,subscription_id TEXT,
      source_message_id TEXT,status TEXT DEFAULT 'pending',attempt_count INTEGER DEFAULT 0,max_attempts INTEGER DEFAULT 3,
      lease_until TEXT,lease_token TEXT,fence INTEGER DEFAULT 1,last_error_code TEXT,reply_message_id TEXT,
      created_at TEXT DEFAULT CURRENT_TIMESTAMP,updated_at TEXT DEFAULT CURRENT_TIMESTAMP,completed_at TEXT,
      UNIQUE(subscription_id,source_message_id),UNIQUE(reply_message_id));
    INSERT INTO channel_threads VALUES('team','stream','thread'),('team','stream','other');
    INSERT INTO oidc_users VALUES('human','human',NULL,'Human'),('agent','agent',NULL,'Agent');
    INSERT INTO team_members VALUES('team','agent');
    INSERT INTO thread_agent_subscriptions(id,team_id,stream_id,thread_id,agent_principal_id,consent_actor,consented_at,
      disclosure_version,provider_notice,provider_fingerprint) VALUES('sub','team','stream','thread','agent','human',
      CURRENT_TIMESTAMP,'thread-agent-provider-notice-v1','notice','${fingerprint()}');
  `);
  database.all.mockImplementation(async (sql: string, values: unknown[] = []) =>
    connection.prepare(sql).all(...params(values)),
  );
  database.get.mockImplementation(async (sql: string, values: unknown[] = []) =>
    connection.prepare(sql).get(...params(values)),
  );
  database.run.mockImplementation(async (sql: string, values: unknown[] = []) =>
    connection.prepare(sql).run(...params(values)),
  );
  database.transaction.mockImplementation(async (statements: Array<{ s: string; d?: unknown[] }>) => {
    connection.exec("BEGIN IMMEDIATE");
    try {
      for (const statement of statements) {
        connection.prepare(statement.s).run(...params(statement.d));
      }
      connection.exec("COMMIT");
    } catch (error) {
      connection.exec("ROLLBACK");
      throw error;
    }
  });
  insertMessage("source", "thread", "human", { text: "current-thread message" });
  insertMessage("other-message", "other", "human", { text: "secret from other thread" });
  insertTurn();
});

afterEach(() => {
  connection.close();
  vi.resetAllMocks();
  for (const [key, value] of Object.entries(originalEnvironment)) {
    if (value === undefined) {
      delete process.env[key];
    } else {
      process.env[key] = value;
    }
  }
});

describe("Thread Agent provider worker", () => {
  it("sends only current-thread bodies and atomically links a reply under Agent author", async () => {
    for (let index = 0; index < 21; index += 1) {
      insertMessage(`current-${index}`, "thread", "private-author", { text: `bounded-${index}` });
    }
    mockCreate.mockResolvedValue({ choices: [{ message: { content: "Agent reply" } }] });
    await repository.respond({
      id: "turn",
      team_id: "team",
      stream_id: "stream",
      thread_id: "thread",
      subscription_id: "sub",
      token: "token",
      fence: 1,
    });

    expect(mockCreate).toHaveBeenCalledOnce();
    const request = mockCreate.mock.calls[0][0];
    expect(request.model).toBe("model-a");
    expect(request).not.toHaveProperty("tools");
    const context = request.messages.slice(1);
    expect(context).toHaveLength(20);
    expect(context[0]).toEqual({ role: "user", content: JSON.stringify({ text: "bounded-1" }) });
    expect(context.at(-1)).toEqual({ role: "user", content: JSON.stringify({ text: "bounded-20" }) });
    expect(
      Buffer.byteLength(context.map((message: { content: string }) => message.content).join("")),
    ).toBeLessThanOrEqual(24_000);
    expect(JSON.stringify(request)).not.toContain("secret from other thread");
    expect(JSON.stringify(request)).not.toContain("private-author");
    const turn = connection
      .prepare("SELECT status,reply_message_id FROM thread_agent_turns WHERE id='turn'")
      .get() as any;
    expect(turn.status).toBe("complete");
    const reply = connection
      .prepare("SELECT author,thread_id,body_json FROM channel_thread_messages WHERE id=?")
      .get(turn.reply_message_id) as any;
    expect(reply).toMatchObject({
      author: "agent",
      thread_id: "thread",
      body_json: JSON.stringify({ text: "Agent reply" }),
    });
  });

  it("stores only a safe provider error code and terminal failure status", async () => {
    mockCreate.mockRejectedValue(new Error("private endpoint/token detail"));
    await repository.respond({
      id: "turn",
      team_id: "team",
      stream_id: "stream",
      thread_id: "thread",
      subscription_id: "sub",
      token: "token",
      fence: 1,
    });
    expect(
      connection.prepare("SELECT status,last_error_code FROM thread_agent_turns WHERE id='turn'").get(),
    ).toMatchObject({ status: "failed", last_error_code: "provider_request_failed" });
    expect(
      connection.prepare("SELECT count(*) AS n FROM channel_thread_messages WHERE author='agent'").get(),
    ).toMatchObject({ n: 0 });
  });

  it.each(["provider", "disclosure"])("does not dispatch on %s configuration mismatch", async (mismatch) => {
    if (mismatch === "provider") {
      process.env.OPENAI_API_MODEL = "other-model";
    } else {
      process.env.THREAD_AGENT_PROVIDER_NOTICE = "changed-notice";
    }
    await repository.respond({
      id: "turn",
      team_id: "team",
      stream_id: "stream",
      thread_id: "thread",
      subscription_id: "sub",
      token: "token",
      fence: 1,
    });
    expect(mockCreate).not.toHaveBeenCalled();
    expect(
      connection.prepare("SELECT status,last_error_code FROM thread_agent_turns WHERE id='turn'").get(),
    ).toMatchObject({ status: "disabled", last_error_code: "authorization_changed" });
  });
});
