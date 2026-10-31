import { afterEach, describe, expect, it, vi } from "vitest";
import { DatabaseSync } from "node:sqlite";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const testDb = vi.hoisted(() => ({ database: null as DatabaseSync | null }));
let temporaryDirectory: string | null = null;
vi.mock("./db-client.js", () => ({
  default: {
    all: async (sql: string, values: unknown[] = []) => testDb.database!.prepare(sql).all(...(values as any[])),
    get: async (sql: string, values: unknown[] = []) => testDb.database!.prepare(sql).get(...(values as any[])),
    run: async (sql: string, values: unknown[] = []) => testDb.database!.prepare(sql).run(...(values as any[])),
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
}));

import { DomainEventDeliveryRepository } from "./domain-event-delivery-repository.js";

afterEach(() => {
  testDb.database?.close();
  testDb.database = null;
  if (temporaryDirectory) {
    fs.rmSync(temporaryDirectory, { recursive: true, force: true });
    temporaryDirectory = null;
  }
});

describe("domain event outcome projection in SQLite", () => {
  it("projects persisted fanout and delivery outcomes after reopen without leaking details", async () => {
    temporaryDirectory = fs.mkdtempSync(path.join(os.tmpdir(), "domain-event-projection-"));
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
      INSERT INTO domain_events VALUES ('event', 'team', 1, 'changed'), ('unmatched', 'team', 2, 'other');
      INSERT INTO domain_event_subscriptions(id, team_id, workflow_id, workflow_revision, event_type)
        VALUES ('sub-a', 'team', 'wf-a', 1, 'changed'), ('sub-b', 'team', 'wf-b', 1, 'changed');
      `);
    const repository = new DomainEventDeliveryRepository();
    testDb.database.exec(`CREATE TRIGGER reject_fanout_outcome BEFORE INSERT ON domain_event_fanout_outcomes
      BEGIN SELECT RAISE(ABORT, 'injected fanout outcome failure'); END`);
    await expect(repository.fanout("team", "event")).rejects.toThrow("injected fanout outcome failure");
    expect(
      testDb.database.prepare("SELECT COUNT(*) AS count FROM domain_event_deliveries WHERE event_id = 'event'").get(),
    ).toEqual({ count: 0 });
    testDb.database.exec("DROP TRIGGER reject_fanout_outcome");
    expect(await repository.fanout("team", "event")).toEqual({ status: "matched", deliveryCount: 2 });
    expect(await repository.fanout("team", "event")).toEqual({ status: "repeat", deliveryCount: 2 });
    expect(await repository.fanout("team", "unmatched")).toEqual({ status: "unmatched", deliveryCount: 0 });
    const deliveries = await repository.listForEvent("team", "event");
    const [filtered, failed] = deliveries;
    const claimFiltered = await repository.claimNext("team");
    expect(claimFiltered?.id).toBe(filtered.id);
    await repository.finish("team", filtered.id, claimFiltered!.attemptCount, {
      status: "filtered",
      error: "private-filter-reason",
      jobIds: ["private-job"],
      invocationId: "private-invocation",
    });
    const claimFailed = await repository.claimNext("team");
    expect(claimFailed?.id).toBe(failed.id);
    await repository.finish("team", failed.id, claimFailed!.attemptCount, {
      status: "failed",
      error: "sensitive admission details",
      jobIds: ["private-job-2"],
      invocationId: "private-invocation-2",
    });

    testDb.database.close();
    testDb.database = new DatabaseSync(databasePath);
    const reopened = new DomainEventDeliveryRepository();
    expect(await reopened.getOutcomeProjection("team", "event")).toEqual({
      eventId: "event",
      fanout: "repeat",
      repeatSemantics: "idempotent-repeat",
      deliveries: [{ status: "filtered" }, { status: "failed" }],
    });
    expect(await reopened.getOutcomeProjection("team", "unmatched")).toEqual({
      eventId: "unmatched",
      fanout: "unmatched",
      repeatSemantics: null,
      deliveries: [],
    });
    const serialized = JSON.stringify(await reopened.getOutcomeProjection("team", "event"));
    expect(serialized).not.toContain("private");
    expect(serialized).not.toContain("sensitive");
  });
});
