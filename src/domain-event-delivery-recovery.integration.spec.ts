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
      transaction: async (statements: Array<{ s: string; d: unknown[] }>) => {
        testDb.database!.exec("BEGIN IMMEDIATE");
        try {
          for (const statement of statements) {
            testDb.database!.prepare(statement.s).run(...(statement.d as any[]));
          }
          testDb.database!.exec("COMMIT");
        } catch (error) {
          testDb.database!.exec("ROLLBACK");
          throw error;
        }
      },
    },
  };
});

import { DomainEventDeliveryRepository } from "./domain-event-delivery-repository.js";
import { DomainEventDispatcher } from "./domain-event-dispatcher.js";
import { WorkflowRunAdmissionRepository } from "./workflow-run-admission-repository.js";
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
  it("persists successful subscription admission linked to its invocation request event after reopen", async () => {
    temporaryDirectory = fs.mkdtempSync(path.join(os.tmpdir(), "domain-event-admitted-run-"));
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
      CREATE TABLE domain_event_fanout_outcomes (
        team_id TEXT NOT NULL, event_id TEXT NOT NULL, status TEXT NOT NULL, delivery_count INTEGER NOT NULL,
        updated_at TEXT DEFAULT CURRENT_TIMESTAMP, PRIMARY KEY(team_id, event_id)
      );
      CREATE TABLE workflow_run_admissions (
        event_id TEXT NOT NULL, team_id TEXT NOT NULL, workflow_id TEXT NOT NULL, revision INTEGER NOT NULL,
        variant_index INTEGER NOT NULL, matrix_json TEXT NOT NULL, tags_json TEXT NOT NULL,
        status TEXT NOT NULL DEFAULT 'pending', admission_outcome TEXT, job_id INTEGER, error_code TEXT,
        lease_token TEXT, lease_until TEXT, retry_after TEXT, updated_at TEXT DEFAULT CURRENT_TIMESTAMP,
        PRIMARY KEY(event_id, variant_index)
      );
      CREATE TABLE workflow_run_admission_plans (
        event_id TEXT PRIMARY KEY, variant_count INTEGER NOT NULL, plan_hash TEXT NOT NULL
      );
      INSERT INTO domain_events VALUES ('source-event', 'team', 1, 'dispatch');
      INSERT INTO domain_event_subscriptions(id, team_id, workflow_id, workflow_revision, event_type)
        VALUES ('sub', 'team', 'wf', 7, 'dispatch');
    `);
    const deliveryRepository = new DomainEventDeliveryRepository();
    await deliveryRepository.fanout("team", "source-event");
    const claimed = await deliveryRepository.claimNext("team");
    expect(claimed).not.toBeNull();
    const dispatcher = new DomainEventDispatcher({
      events: {
        getForTeam: async (_team, id) => ({
          id,
          teamId: "team",
          type: "dispatch",
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
        getForTeam: async (team, id) => deliveryRepository.getForTeam(team, id),
      },
      deliveries: deliveryRepository,
      resolveWorkflow: async () => ({ name: "wf", steps: [] }) as unknown as ParsedWorkflow,
      admitInvocation: async ({ idempotencyKey }) => {
        // This records accepted admission only. The terminal job identifier is a fixture,
        // not evidence that a worker executed the job.
        const admissions = new WorkflowRunAdmissionRepository();
        const invocationEventId = `invocation-request:${idempotencyKey}`;
        const variant = {
          eventId: invocationEventId,
          teamId: "team",
          workflowId: "wf",
          revision: 7,
          index: 0,
          matrix: {},
          tags: [],
        };
        await admissions.persistPlan([variant]);
        const claimedVariant = await admissions.claimVariant(invocationEventId, 0);
        expect(claimedVariant).not.toBeNull();
        expect(await admissions.finish(claimedVariant!, "admitted", 42)).toBe(true);
        return { eventId: invocationEventId, invocationId: `invocation:${invocationEventId}` };
      },
    });
    await dispatcher.process(claimed!);
    testDb.database.close();
    testDb.database = new DatabaseSync(databasePath);
    const reopenedDeliveries = new DomainEventDeliveryRepository();
    const reopenedAdmissions = new WorkflowRunAdmissionRepository();
    const delivery = (await reopenedDeliveries.listForEvent("team", "source-event"))[0];
    expect(delivery).toMatchObject({ status: "admitted" });
    expect(delivery.invocationId).toMatch(/^invocation:invocation-request:/);
    const invocationEventId = delivery.invocationId!.replace(/^invocation:/, "");
    expect(await reopenedAdmissions.getPlan(invocationEventId)).toEqual([
      {
        eventId: invocationEventId,
        teamId: "team",
        workflowId: "wf",
        revision: 7,
        index: 0,
        matrix: {},
        tags: [],
      },
    ]);
    expect(await reopenedAdmissions.get(invocationEventId, 0)).toMatchObject({
      status: "admitted",
      admissionOutcome: "accepted",
      jobId: 42,
    });
  });

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
      CREATE TABLE domain_event_fanout_outcomes (
        team_id TEXT NOT NULL, event_id TEXT NOT NULL, status TEXT NOT NULL, delivery_count INTEGER NOT NULL,
        updated_at TEXT DEFAULT CURRENT_TIMESTAMP, PRIMARY KEY(team_id, event_id)
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

    expect(await repository.fanout("team", "admit-event")).toEqual({
      status: "matched",
      deliveryCount: 4,
    });
    expect(await repository.fanout("team", "admit-event")).toEqual({
      status: "repeat",
      deliveryCount: 4,
    });
    expect(await repository.fanout("team", "filtered-event")).toEqual({
      status: "matched",
      deliveryCount: 4,
    });
    expect(await repository.fanout("team", "missing-event")).toEqual({
      status: "matched",
      deliveryCount: 4,
    });
    expect(await repository.fanout("team", "retry-event")).toEqual({
      status: "matched",
      deliveryCount: 4,
    });
    expect(await repository.fanout("team", "unmatched-event")).toEqual({
      status: "unmatched",
      deliveryCount: 0,
    });

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
    expect(await reopened.getFanoutOutcome("team", "admit-event")).toEqual({
      status: "repeat",
      deliveryCount: 4,
    });
    expect(await reopened.getFanoutOutcome("team", "unmatched-event")).toEqual({
      status: "unmatched",
      deliveryCount: 0,
    });
    // Admission records admission only, not successful workflow execution.
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
      CREATE TABLE domain_event_fanout_outcomes (
        team_id TEXT NOT NULL, event_id TEXT NOT NULL, status TEXT NOT NULL, delivery_count INTEGER NOT NULL,
        updated_at TEXT DEFAULT CURRENT_TIMESTAMP, PRIMARY KEY(team_id, event_id)
      );
      CREATE TABLE admissions (key TEXT PRIMARY KEY, job_id INTEGER);
      INSERT INTO domain_events VALUES ('event', 'team', 1, 'changed');
      INSERT INTO domain_event_subscriptions(id, team_id, workflow_id, workflow_revision, event_type)
        VALUES ('sub-a', 'team', 'wf-a', 1, 'changed'), ('sub-b', 'team', 'wf-b', 1, 'changed');
    `);
    const repository = new DomainEventDeliveryRepository();
    expect(await repository.fanout("team", "event")).toEqual({
      status: "matched",
      deliveryCount: 2,
    });
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
    expect(await restarted.fanout("team", "event")).toEqual({
      status: "repeat",
      deliveryCount: 2,
    });
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
