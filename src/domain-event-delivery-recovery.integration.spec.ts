import { afterEach, describe, expect, it, vi } from "vitest";
import { DatabaseSync } from "node:sqlite";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const testDb = vi.hoisted(() => ({ database: null as DatabaseSync | null }));
let temporaryDirectory: string | null = null;
vi.mock("./db-client.js", () => {
  const execute = (sql: string, values: unknown[] = []) => testDb.database!.prepare(sql).run(...(values as any[]));
  return {
    default: {
      all: async (sql: string, values: unknown[] = []) => testDb.database!.prepare(sql).all(...(values as any[])),
      get: async (sql: string, values: unknown[] = []) => testDb.database!.prepare(sql).get(...(values as any[])),
      run: async (sql: string, values: unknown[] = []) => execute(sql, values),
    },
  };
});

import { DomainEventDeliveryRepository } from "./domain-event-delivery-repository.js";
import { DomainEventDispatcher } from "./domain-event-dispatcher.js";
import type { DomainEvent } from "./domain-event-repository.js";
import type { ParsedWorkflow } from "./types.js";

afterEach(() => {
  testDb.database?.close();
  testDb.database = null;
  if (temporaryDirectory) {
    fs.rmSync(temporaryDirectory, { recursive: true, force: true });
    temporaryDirectory = null;
  }
});

describe("domain event delivery recovery in SQLite", () => {
  it("persists dispatcher outcomes independently across consumers and a SQLite reopen", async () => {
    temporaryDirectory = fs.mkdtempSync(path.join(os.tmpdir(), "domain-event-outcomes-"));
    const databasePath = path.join(temporaryDirectory, "test.sqlite");
    testDb.database = new DatabaseSync(databasePath);
    testDb.database.exec(`
      CREATE TABLE domain_events (id TEXT, team_id TEXT, sequence INTEGER, type TEXT);
      CREATE TABLE domain_event_subscriptions (
        id TEXT PRIMARY KEY, team_id TEXT, workflow_id TEXT, workflow_revision INTEGER,
        event_type TEXT, enabled INTEGER DEFAULT 1, high_water_event_sequence INTEGER DEFAULT 0,
        created_at TEXT DEFAULT CURRENT_TIMESTAMP
      );
      CREATE TABLE domain_event_deliveries (
        id TEXT PRIMARY KEY, team_id TEXT, event_id TEXT, subscription_id TEXT,
        status TEXT DEFAULT 'pending', attempt_count INTEGER DEFAULT 0, lease_until TEXT,
        job_ids_json TEXT DEFAULT '[]', invocation_id TEXT, last_error TEXT, created_at TEXT DEFAULT CURRENT_TIMESTAMP,
        updated_at TEXT DEFAULT CURRENT_TIMESTAMP, UNIQUE(team_id, event_id, subscription_id)
      );
      INSERT INTO domain_events VALUES
        ('admit-event', 'team', 1, 'dispatch'), ('filtered-event', 'team', 2, 'dispatch'),
        ('missing-event', 'team', 3, 'dispatch'), ('retry-event', 'team', 4, 'dispatch'),
        ('unmatched-event', 'team', 5, 'other');
      INSERT INTO domain_event_subscriptions(id, team_id, workflow_id, workflow_revision, event_type)
        VALUES ('admit', 'team', 'wf-admit', 3, 'dispatch'),
          ('filtered', 'team', 'wf-filtered', 4, 'dispatch'),
          ('missing', 'team', 'wf-missing', 5, 'dispatch'),
          ('retry', 'team', 'wf-retry', 6, 'dispatch');
    `);
    const repository = new DomainEventDeliveryRepository();
    const dispatcher = new DomainEventDispatcher({
      events: {
        getForTeam: async (_team, id) => ({
          id,
          teamId: "team",
          type: id === "unmatched-event" ? "other" : "dispatch",
          schemaVersion: 1,
          source: "test",
          occurredAt: "now",
          recordedAt: "now",
          correlationId: null,
          causationId: null,
          idempotencyKey: null,
          data: {},
        }),
      },
      subscriptions: {
        getForTeam: async (team, id) => repository.getForTeam(team, id),
      },
      deliveries: repository,
      resolveWorkflow: async (_team, workflowId) =>
        workflowId === "wf-missing" ? null : ({ name: workflowId, steps: [] } as unknown as ParsedWorkflow),
      matches: (_event, subscription) => subscription.id !== "filtered",
      admitInvocation: async ({ workflowId, idempotencyKey }) => {
        if (workflowId === "wf-retry") {
          throw new Error("temporary admission error");
        }
        return {
          eventId: `run-event-${idempotencyKey}`,
          invocationId: `invocation-${workflowId}`,
        };
      },
    });

    expect(await repository.fanout("team", "admit-event")).toBe(4);
    expect(await repository.fanout("team", "admit-event")).toBe(4);
    expect(await repository.fanout("team", "filtered-event")).toBe(4);
    expect(await repository.fanout("team", "missing-event")).toBe(4);
    expect(await repository.fanout("team", "retry-event")).toBe(4);
    expect(await repository.fanout("team", "unmatched-event")).toBe(0);

    for (let index = 0; index < 16; index += 1) {
      const claimed = await repository.claimNext("team");
      expect(claimed).not.toBeNull();
      await dispatcher.process(claimed!);
    }

    testDb.database.close();
    testDb.database = new DatabaseSync(databasePath);
    const reopened = new DomainEventDeliveryRepository();
    const outcome = async (eventId: string, subscriptionId: string) =>
      (await reopened.listForEvent("team", eventId)).find((delivery) => delivery.subscriptionId === subscriptionId);
    expect(await outcome("admit-event", "admit")).toMatchObject({
      status: "admitted",
      jobIds: [],
      invocationId: "invocation-wf-admit",
      lastError: null,
    });
    expect(await outcome("filtered-event", "filtered")).toMatchObject({
      status: "filtered",
      jobIds: [],
      lastError: null,
    });
    expect(await outcome("missing-event", "missing")).toMatchObject({
      status: "failed",
      jobIds: [],
      lastError: "Pinned workflow revision is unavailable",
    });
    expect(await outcome("retry-event", "retry")).toMatchObject({
      status: "pending",
      jobIds: [],
      lastError: "Domain event invocation could not be admitted",
    });
    expect(await reopened.listForEvent("team", "admit-event")).toHaveLength(4);
    expect(await reopened.listForEvent("team", "unmatched-event")).toHaveLength(0);
    // Duplicate fanout is represented by the unchanged delivery count; unmatched events have no rows,
    // and admission records admission only, not successful workflow execution. No extra statuses exist.
    expect(
      (await reopened.listForEvent("team", "admit-event")).filter((delivery) => delivery.status === "admitted"),
    ).toHaveLength(1);
  });

  it("recovers only the expired consumer and preserves independent outcomes and idempotent admission", async () => {
    temporaryDirectory = fs.mkdtempSync(path.join(os.tmpdir(), "domain-event-recovery-"));
    const databasePath = path.join(temporaryDirectory, "test.sqlite");
    testDb.database = new DatabaseSync(databasePath);
    testDb.database.exec(`
      CREATE TABLE domain_events (id TEXT, team_id TEXT, sequence INTEGER, type TEXT);
      CREATE TABLE domain_event_subscriptions (
        id TEXT PRIMARY KEY, team_id TEXT, workflow_id TEXT, workflow_revision INTEGER,
        event_type TEXT, enabled INTEGER DEFAULT 1, high_water_event_sequence INTEGER DEFAULT 0,
        created_at TEXT DEFAULT CURRENT_TIMESTAMP
      );
      CREATE TABLE domain_event_deliveries (
        id TEXT PRIMARY KEY, team_id TEXT, event_id TEXT, subscription_id TEXT,
        status TEXT DEFAULT 'pending', attempt_count INTEGER DEFAULT 0, lease_until TEXT,
        job_ids_json TEXT DEFAULT '[]', invocation_id TEXT, last_error TEXT, created_at TEXT DEFAULT CURRENT_TIMESTAMP,
        updated_at TEXT DEFAULT CURRENT_TIMESTAMP, UNIQUE(team_id, event_id, subscription_id)
      );
      CREATE TABLE admissions (key TEXT PRIMARY KEY, job_id INTEGER);
      INSERT INTO domain_events VALUES ('event', 'team', 1, 'changed');
      INSERT INTO domain_event_subscriptions(id, team_id, workflow_id, workflow_revision, event_type)
        VALUES ('sub-a', 'team', 'wf-a', 1, 'changed'), ('sub-b', 'team', 'wf-b', 1, 'changed');
    `);
    const repository = new DomainEventDeliveryRepository();
    expect(await repository.fanout("team", "event")).toBe(2);
    const initial = await repository.listForEvent("team", "event");
    const [a, b] = initial.sort((left, right) => left.id.localeCompare(right.id));
    const claimA = await repository.claimNext("team");
    expect(claimA?.id).toBe(a.id);
    await repository.finish("team", a.id, claimA!.attemptCount, {
      status: "filtered",
    });
    const claimB = await repository.claimNext("team", 1);
    expect(claimB?.id).toBe(b.id);
    testDb.database
      .prepare("UPDATE domain_event_deliveries SET lease_until = '2000-01-01T00:00:00.000Z' WHERE id = ?")
      .run(b.id);

    testDb.database.close();
    testDb.database = new DatabaseSync(databasePath);
    // Both repository state and admission uniqueness must survive a real SQLite reopen.
    const restarted = new DomainEventDeliveryRepository();
    const reclaimed = await restarted.claimNext("team");
    expect(reclaimed).toMatchObject({ id: b.id, attemptCount: 2 });
    expect(
      await restarted.finish("team", b.id, claimB!.attemptCount, {
        status: "failed",
      }),
    ).toBeNull();

    const event: DomainEvent = {
      id: "event",
      teamId: "team",
      type: "changed",
      schemaVersion: 1,
      source: "test",
      occurredAt: "now",
      recordedAt: "now",
      correlationId: null,
      causationId: null,
      idempotencyKey: null,
      data: {},
    };
    const workflow = { name: "wf", steps: [] } as unknown as ParsedWorkflow;
    const dispatcher = new DomainEventDispatcher({
      events: { getForTeam: async () => event },
      subscriptions: {
        getForTeam: async (_team, id) => restarted.getForTeam("team", id),
      },
      deliveries: restarted,
      resolveWorkflow: async () => workflow,
      admitInvocation: async ({ idempotencyKey }) => {
        testDb.database!.prepare("INSERT OR IGNORE INTO admissions(key, job_id) VALUES (?, ?)").run(idempotencyKey, 1);
        return {
          eventId: "run-event",
          invocationId: `invocation-${testDb.database!.prepare("SELECT job_id FROM admissions WHERE key = ?").get(idempotencyKey)!.job_id}`,
        };
      },
    });
    await dispatcher.process(reclaimed!);
    // Simulate a lost completion acknowledgement: the same claimed delivery is dispatched again.
    await dispatcher.process(reclaimed!);
    expect(await restarted.fanout("team", "event")).toBe(2);
    const final = await restarted.listForEvent("team", "event");
    expect(final.find((delivery) => delivery.id === a.id)).toMatchObject({
      status: "filtered",
      attemptCount: 1,
      jobIds: [],
    });
    expect(final.find((delivery) => delivery.id === b.id)).toMatchObject({
      status: "admitted",
      attemptCount: 2,
      jobIds: [],
      invocationId: "invocation-1",
    });
    expect(testDb.database.prepare("SELECT COUNT(*) AS n FROM admissions").get()).toEqual({ n: 1 });
  });
});
