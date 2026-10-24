import { beforeEach, describe, expect, it, vi } from "vitest";

const database = vi.hoisted(() => ({ transaction: vi.fn(), get: vi.fn() }));
vi.mock("./db-client.js", () => ({ default: database }));

import { QueueManager } from "./queue.js";

const report = { startedAt: "2025-01-01T00:00:00Z", durationMs: 10, steps: [] } as any;

describe("durable terminal completion events", () => {
  beforeEach(() => vi.resetAllMocks());

  it("atomically writes a local terminal job update and secret-free success/failure event", async () => {
    database.transaction.mockResolvedValue(undefined);
    await new QueueManager("local").completeJob(7, "success", report);
    const statements = database.transaction.mock.calls[0][0];
    expect(statements).toHaveLength(2);
    expect(statements[0].s).toContain("UPDATE jobs");
    expect(statements[1].s).toContain("INSERT OR IGNORE INTO domain_events");
    expect(statements[1].s).toContain("CASE jobs.status WHEN 'success' THEN 'workflow.completed'");
    expect(statements[1].s).toContain("workflow-job:' || jobs.id || ':terminal");
    expect(statements[1].s).toContain("jobs.status IN ('success', 'failed')");
    expect(statements[1].s).not.toContain("report");
    expect(statements[1].s).not.toContain("payload");
    expect(statements[1].d).toEqual([7]);
    expect(statements[0].d).toContain(JSON.stringify(report));
  });

  it("does not produce a terminal event for cancellation", async () => {
    database.transaction.mockResolvedValue(undefined);
    await new QueueManager("local").completeJob(8, "cancelled", report);
    const eventStatement = database.transaction.mock.calls[0][0][1].s;
    expect(eventStatement).toContain("jobs.status IN ('success', 'failed')");
    expect(database.transaction.mock.calls[0][0][0].s).toContain("CASE WHEN status = 'cancelled'");
  });

  it("fences runner completion and idempotently inserts the event in the same transaction", async () => {
    database.transaction.mockResolvedValue(undefined);
    database.get.mockResolvedValue({ status: "success", report: JSON.stringify(report) });
    const completed = await new QueueManager("worker").completeJobForRunner(
      7,
      "runner-a",
      "lease-a",
      "hash-a",
      "success",
      report,
    );
    expect(completed).toBe(true);
    const statements = database.transaction.mock.calls[0][0];
    expect(statements[0].s).toContain("lease_id = ? AND lease_token_hash = ?");
    expect(statements[0].s).toContain("lease_fenced = 0 AND lease_completed = 0");
    expect(statements[1].s).toContain("INSERT OR IGNORE INTO domain_events");
    expect(statements[1].s).toContain("jobs.lease_completed = 1");
    expect(statements[1].d).toEqual([7, "runner-a", "lease-a", "hash-a"]);
  });

  it("returns false for stale runner completion", async () => {
    database.transaction.mockResolvedValue(undefined);
    database.get.mockResolvedValue(null);
    await expect(
      new QueueManager("worker").completeJobForRunner(7, "runner-a", "old-lease", "bad", "success", report),
    ).resolves.toBe(false);
    expect(database.transaction.mock.calls[0][0][1].s).toContain("jobs.lease_token_hash = ?");
  });

  it("fails closed when transaction support is unavailable", async () => {
    database.transaction = undefined as any;
    await expect(new QueueManager("local").completeJob(7, "success", report)).rejects.toThrow(
      "Atomic transactions are required",
    );
  });
});
