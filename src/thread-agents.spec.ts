import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DatabaseSync } from "node:sqlite";
import { createHash } from "node:crypto";
import { buildThreadAgentContext, isThreadAgentProviderConfigured, ThreadAgentRepository } from "./thread-agents.js";

const database = vi.hoisted(() => ({
  all: vi.fn(),
  get: vi.fn(),
  run: vi.fn(),
  transaction: vi.fn(),
}));
vi.mock("./db-client.js", () => ({ default: database }));

let connection: DatabaseSync;
const repository = new ThreadAgentRepository();
const originalEnvironment = {
  OPENAI_API_URL: process.env.OPENAI_API_URL,
  OPENAI_API_MODEL: process.env.OPENAI_API_MODEL,
  THREAD_AGENT_PROVIDER_NOTICE: process.env.THREAD_AGENT_PROVIDER_NOTICE,
};
const params = (values: unknown[] = []) => values as import("node:sqlite").SQLInputValue[];

beforeEach(() => {
  process.env.OPENAI_API_URL = "https://provider.example/v1";
  process.env.OPENAI_API_MODEL = "model-a";
  process.env.THREAD_AGENT_PROVIDER_NOTICE = "notice";
  connection = new DatabaseSync(":memory:");
  connection.exec(`
    PRAGMA foreign_keys = ON;
    CREATE TABLE channel_threads(team_id TEXT, channel_id TEXT, id TEXT, PRIMARY KEY(team_id, channel_id, id));
    CREATE TABLE channel_thread_messages(id TEXT PRIMARY KEY, team_id TEXT, channel_id TEXT, thread_id TEXT, author TEXT,
      body_json TEXT, caused_by_event_id TEXT, caused_by_job_id TEXT, created_at TEXT DEFAULT CURRENT_TIMESTAMP,
      UNIQUE(team_id,id));
    CREATE TABLE oidc_users(subject TEXT PRIMARY KEY, kind TEXT, disabled_at TEXT, name TEXT);
    CREATE TABLE team_members(team_id TEXT, subject TEXT, PRIMARY KEY(team_id,subject));
    CREATE TABLE thread_agent_subscriptions(id TEXT PRIMARY KEY, team_id TEXT, stream_id TEXT, thread_id TEXT,
      agent_principal_id TEXT, consent_actor TEXT, consented_at TEXT, disclosure_version TEXT, provider_notice TEXT,
      provider_fingerprint TEXT, enabled INTEGER DEFAULT 1, fence INTEGER DEFAULT 1, created_at TEXT DEFAULT CURRENT_TIMESTAMP,
      disabled_at TEXT, UNIQUE(team_id,id));
    CREATE TABLE thread_agent_turns(id TEXT PRIMARY KEY, team_id TEXT, stream_id TEXT, thread_id TEXT,
      subscription_id TEXT, source_message_id TEXT, status TEXT DEFAULT 'pending', attempt_count INTEGER DEFAULT 0,
      max_attempts INTEGER DEFAULT 3, lease_until TEXT, lease_token TEXT, fence INTEGER DEFAULT 1,
      last_error_code TEXT, reply_message_id TEXT, created_at TEXT DEFAULT CURRENT_TIMESTAMP,
      updated_at TEXT DEFAULT CURRENT_TIMESTAMP, completed_at TEXT, UNIQUE(subscription_id,source_message_id),
      UNIQUE(reply_message_id));
    INSERT INTO channel_threads VALUES ('team','stream','thread'), ('team','stream','other');
    INSERT INTO oidc_users VALUES ('human','human',NULL,'Human'), ('agent','agent',NULL,'Agent');
    INSERT INTO team_members VALUES ('team','agent'), ('team','human');
    INSERT INTO thread_agent_subscriptions(id,team_id,stream_id,thread_id,agent_principal_id,consent_actor,consented_at,
      disclosure_version,provider_notice,provider_fingerprint) VALUES ('sub','team','stream','thread','agent','human',
      CURRENT_TIMESTAMP,'thread-agent-provider-notice-v1','notice',?);
  `);
  const fingerprint =
    process.env.OPENAI_API_URL && process.env.OPENAI_API_MODEL
      ? createHashForTest(process.env.OPENAI_API_URL, process.env.OPENAI_API_MODEL)
      : null;
  // Fixture values are bound separately because provider configuration is established per test.
  connection.prepare("UPDATE thread_agent_subscriptions SET provider_fingerprint = ?").run(fingerprint);
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
});

function createHashForTest(url: string, model: string): string {
  const endpoint = new URL(url);
  return createHash("sha256")
    .update(JSON.stringify([endpoint.toString(), model]))
    .digest("hex");
}

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

describe("Thread Agent context", () => {
  it.each([
    ["http://127.0.0.1:12345/v1", true],
    ["http://localhost:12345/v1", true],
    ["http://provider.example/v1", false],
    ["https://provider.example/v1?token=secret", false],
  ])("accepts only HTTPS or loopback HTTP provider endpoints (%s)", (apiUrl, expected) => {
    process.env.OPENAI_API_URL = apiUrl;
    expect(isThreadAgentProviderConfigured()).toBe(expected);
  });

  it("bounds message count and bytes and carries only text as untrusted user content", () => {
    const messages = Array.from({ length: 30 }, (_, index) => ({
      body: { text: `message-${index}` },
    }));
    const context = buildThreadAgentContext(messages);
    expect(context).toHaveLength(20);
    expect(context[0]).toEqual({
      role: "user",
      content: JSON.stringify({ text: "message-10" }),
    });
    const bounded = buildThreadAgentContext([{ body: "x".repeat(100_000) }, { body: "later" }]);
    expect(Buffer.byteLength(bounded.map(({ content }) => content).join(""))).toBeLessThanOrEqual(24_000);
    expect(bounded.at(-1)?.content).toBe("later");
    expect(bounded).toHaveLength(2);
    const unicode = buildThreadAgentContext([{ body: "x".repeat(23_999) + "🙂" }]);
    expect(Buffer.byteLength(unicode.map(({ content }) => content).join(""))).toBeLessThanOrEqual(24_000);
  });
});

describe("Thread Agent SQLite repository", () => {
  it("admits one turn idempotently for a human message and keeps thread isolation", async () => {
    await repository.appendHumanMessage({
      teamId: "team",
      streamId: "stream",
      threadId: "thread",
      author: "human",
      body: { text: "hello" },
    });
    const message = connection.prepare("SELECT id FROM channel_thread_messages WHERE author='human'").get() as {
      id: string;
    };
    expect(
      connection.prepare("SELECT count(*) AS n FROM thread_agent_turns WHERE source_message_id=?").get(message.id),
    ).toMatchObject({ n: 1 });
    await connection
      .prepare(
        "INSERT OR IGNORE INTO thread_agent_turns(id,team_id,stream_id,thread_id,subscription_id,source_message_id) VALUES('duplicate','team','stream','thread','sub',?)",
      )
      .run(message.id);
    expect(
      connection.prepare("SELECT count(*) AS n FROM thread_agent_turns WHERE source_message_id=?").get(message.id),
    ).toMatchObject({ n: 1 });
    await expect(
      repository.appendHumanMessage({
        teamId: "team",
        streamId: "stream",
        threadId: "other",
        author: "human",
        body: { text: "other" },
      }),
    ).resolves.toBeTruthy();
    expect(connection.prepare("SELECT count(*) AS n FROM thread_agent_turns").get()).toMatchObject({ n: 1 });
  });

  it("enforces unique concurrent claims and fences expired claims", async () => {
    connection
      .prepare(
        "INSERT INTO channel_thread_messages(id,team_id,channel_id,thread_id,author,body_json) VALUES('m','team','stream','thread','human','{}')",
      )
      .run();
    connection
      .prepare(
        "INSERT INTO thread_agent_turns(id,team_id,stream_id,thread_id,subscription_id,source_message_id) VALUES('turn','team','stream','thread','sub','m')",
      )
      .run();
    const claims = await Promise.all([repository.claim(), repository.claim()]);
    expect(claims.filter(Boolean)).toHaveLength(1);
    connection.prepare("UPDATE thread_agent_turns SET lease_until='2000-01-01 00:00:00' WHERE id='turn'").run();
    const reclaimed = await repository.claim();
    expect(reclaimed?.fence).toBe((claims.find(Boolean) as any).fence + 1);
  });

  it("increments subscription fencing and disables active turns exactly once", async () => {
    connection
      .prepare(
        "INSERT INTO thread_agent_turns(id,team_id,stream_id,thread_id,subscription_id,source_message_id,status) VALUES('turn','team','stream','thread','sub','source','pending')",
      )
      .run();
    await repository.disable("team", "stream", "thread", "sub");
    expect(
      connection.prepare("SELECT enabled,fence FROM thread_agent_subscriptions WHERE id='sub'").get(),
    ).toMatchObject({ enabled: 0, fence: 2 });
    expect(connection.prepare("SELECT status FROM thread_agent_turns WHERE id='turn'").get()).toMatchObject({
      status: "disabled",
    });
    await repository.disable("team", "stream", "thread", "sub");
    expect(connection.prepare("SELECT fence FROM thread_agent_subscriptions WHERE id='sub'").get()).toMatchObject({
      fence: 2,
    });
  });

  it("fences a claim racing disable so the claimed worker cannot retain an active turn", async () => {
    connection
      .prepare(
        "INSERT INTO thread_agent_turns(id,team_id,stream_id,thread_id,subscription_id,source_message_id,status) VALUES('race','team','stream','thread','sub','race-source','pending')",
      )
      .run();
    const claimPromise = repository.claim();
    const disablePromise = repository.disable("team", "stream", "thread", "sub");
    const [claim] = await Promise.all([claimPromise, disablePromise]);
    expect(claim).toBeNull();
    expect(connection.prepare("SELECT status,lease_token FROM thread_agent_turns WHERE id='race'").get()).toMatchObject(
      { status: "disabled", lease_token: null },
    );
    expect(connection.prepare("SELECT enabled FROM thread_agent_subscriptions WHERE id='sub'").get()).toMatchObject({
      enabled: 0,
    });
  });

  it("does not dispatch after provider configuration changes and marks uncertain calls terminal", async () => {
    connection
      .prepare(
        "INSERT INTO thread_agent_turns(id,team_id,stream_id,thread_id,subscription_id,source_message_id,status) VALUES('changed','team','stream','thread','sub','changed-source','pending')",
      )
      .run();
    process.env.OPENAI_API_MODEL = "different-model";
    await expect(repository.claim()).resolves.toBeNull();
    expect(connection.prepare("SELECT enabled FROM thread_agent_subscriptions WHERE id='sub'").get()).toMatchObject({
      enabled: 0,
    });
    expect(
      connection.prepare("SELECT status,last_error_code FROM thread_agent_turns WHERE id='changed'").get(),
    ).toMatchObject({ status: "disabled", last_error_code: "provider_configuration_changed" });
    process.env.OPENAI_API_MODEL = "model-a";
    connection
      .prepare("UPDATE thread_agent_subscriptions SET enabled = 1, provider_fingerprint = ? WHERE id='sub'")
      .run(createHashForTest(process.env.OPENAI_API_URL!, process.env.OPENAI_API_MODEL));

    connection
      .prepare(
        "INSERT INTO thread_agent_turns(id,team_id,stream_id,thread_id,subscription_id,source_message_id,status,lease_until) VALUES('uncertain','team','stream','thread','sub','uncertain-source','calling','2000-01-01 00:00:00')",
      )
      .run();
    await expect(repository.claim()).resolves.toBeNull();
    expect(
      connection.prepare("SELECT status,last_error_code FROM thread_agent_turns WHERE id='uncertain'").get(),
    ).toMatchObject({
      status: "failed",
      last_error_code: "provider_outcome_uncertain",
    });
  });
});
