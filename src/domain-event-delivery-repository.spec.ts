import { beforeEach, describe, expect, it, vi } from "vitest";

const database = vi.hoisted(() => ({ all: vi.fn(), get: vi.fn(), run: vi.fn() }));
vi.mock("./db-client.js", () => ({ default: database }));

import { DomainEventDeliveryRepository } from "./domain-event-delivery-repository.js";

describe("DomainEventDeliveryRepository", () => {
  const repository = new DomainEventDeliveryRepository();
  beforeEach(() => vi.resetAllMocks());

  it("scopes subscription creation and listing to the requested team", async () => {
    database.get.mockResolvedValueOnce({ present: 1 }).mockResolvedValueOnce({
      id: "sub",
      team_id: "team-a",
      workflow_id: "wf",
      workflow_revision: 2,
      event_type: "order.created",
      enabled: 1,
      created_at: "2025-01-01 00:00:00",
    });
    database.all.mockResolvedValueOnce([]);
    await expect(
      repository.createSubscription("team-a", {
        id: "sub",
        workflowId: "wf",
        workflowRevision: 2,
        eventType: "order.created",
      }),
    ).resolves.toMatchObject({ teamId: "team-a", workflowRevision: 2 });
    expect(database.get.mock.calls[0]).toEqual([
      "SELECT 1 AS present FROM workflows WHERE team_id = ? AND id = ?",
      ["team-a", "wf"],
    ]);
    expect(database.run.mock.calls[0][0]).toContain(
      "SELECT COALESCE(MAX(sequence), 0) FROM domain_events WHERE team_id = ?",
    );
    expect(database.run.mock.calls[0][1].at(-1)).toBe("team-a");
    await repository.listSubscriptions("team-b");
    expect(database.all.mock.calls[0][1]).toEqual(["team-b"]);
  });

  it("rejects cross-team workflows and events", async () => {
    database.get.mockResolvedValueOnce(null).mockResolvedValueOnce(null);
    await expect(
      repository.createSubscription("team-a", {
        workflowId: "wf",
        workflowRevision: 1,
        eventType: "x",
      }),
    ).rejects.toThrow("Workflow not found for team");
    await expect(repository.fanout("team-a", "event-b")).rejects.toThrow("Event not found for team");
    expect(database.get.mock.calls[1][1]).toEqual(["team-a", "event-b"]);
  });

  it("fans out only currently matching subscriptions and tolerates duplicates", async () => {
    database.get.mockResolvedValueOnce({ sequence: 9, type: "order.created" }).mockResolvedValueOnce({ count: 1 });
    await expect(repository.fanout("team-a", "event-a")).resolves.toBe(1);
    expect(database.run.mock.calls[0][0]).toContain("INSERT OR IGNORE");
    expect(database.run.mock.calls[0][0]).toContain("? > s.high_water_event_sequence");
    expect(database.run.mock.calls[0][1]).toEqual(["team-a", "event-a", "team-a", "order.created", 9]);
    expect(database.get.mock.calls[1][1]).toEqual(["team-a", "event-a"]);
  });

  it("repairs missing fanout without backfilling events before subscription start", async () => {
    database.run.mockResolvedValueOnce({ changes: 3 });
    await expect(repository.reconcileFanout(1000)).resolves.toBe(3);
    expect(database.run.mock.calls[0][0]).toContain("e.sequence > s.high_water_event_sequence");
    expect(database.run.mock.calls[0][1]).toEqual([500]);
  });

  it("uses a durable event sequence high-water mark rather than timestamps", async () => {
    database.get.mockResolvedValueOnce({ sequence: 4, type: "order.created" }).mockResolvedValueOnce({ count: 0 });
    await repository.fanout("team-a", "before-subscription");
    expect(database.run.mock.calls[0][0]).toContain("? > s.high_water_event_sequence");
    expect(database.run.mock.calls[0][1].at(-1)).toBe(4);
    database.get.mockReset();
    database.run.mockReset();
    database.get.mockResolvedValueOnce({ sequence: 5, type: "order.created" }).mockResolvedValueOnce({ count: 1 });
    await repository.fanout("team-a", "after-subscription");
    expect(database.run.mock.calls[0][1].at(-1)).toBe(5);
  });

  it("atomically claims pending and expired leases, and increments attempts", async () => {
    database.get.mockResolvedValueOnce(null);
    await expect(repository.claimNext("team-a")).resolves.toBeNull();
    const query = database.get.mock.calls[0][0];
    expect(query).toContain("UPDATE domain_event_deliveries");
    expect(query).toContain("RETURNING *");
    expect(query).toContain("julianday(lease_until) <= julianday('now')");
    expect(query).toContain("attempt_count = attempt_count + 1");
    expect(query).toContain("lease_until IS NULL OR julianday(lease_until) <= julianday('now')");
    expect(database.get.mock.calls[0][1].slice(1)).toEqual(["team-a", "team-a"]);
  });

  it.each(["admitted", "filtered", "failed", "pending"] as const)("finishes delivery as %s", async (status) => {
    database.get.mockResolvedValueOnce({
      id: "d",
      team_id: "team-a",
      event_id: "e",
      subscription_id: "s",
      status,
      attempt_count: 1,
      lease_until: null,
      job_ids_json: '["job"]',
      last_error: "oops",
      created_at: "now",
      updated_at: "now",
    });
    await expect(
      repository.finish("team-a", "d", 1, { status, jobIds: ["job"], error: "oops" }),
    ).resolves.toMatchObject({
      status,
      jobIds: ["job"],
    });
    expect(database.get.mock.calls[0][0]).toContain("AND attempt_count = ?");
    expect(database.get.mock.calls[0][1].slice(4)).toEqual(["team-a", "d", 1]);
  });

  it("does not let a stale claim overwrite the result of a newer claim", async () => {
    database.get.mockResolvedValueOnce(null);
    await expect(repository.finish("team-a", "d", 1, { status: "failed" })).resolves.toBeNull();
    expect(database.get.mock.calls[0][0]).toContain("attempt_count = ?");
    expect(database.get.mock.calls[0][1].at(-1)).toBe(1);
  });

  it("fails pending retries at the documented attempt limit", async () => {
    database.get.mockResolvedValueOnce({
      status: "failed",
      attempt_count: 12,
      job_ids_json: "[]",
      created_at: "now",
      updated_at: "now",
    });
    await repository.finish("team-a", "d", 12, { status: "pending" });
    expect(database.get.mock.calls[0][1][0]).toBe("failed");
  });

  it("lists event deliveries by workspace and permits explicit retry only when failed", async () => {
    database.all.mockResolvedValueOnce([]);
    await repository.listForEvent("team-a", "event-a");
    expect(database.all.mock.calls[0][1]).toEqual(["team-a", "event-a"]);
    database.get.mockResolvedValueOnce(null);
    await expect(repository.retryFailed("team-a", "delivery-a")).resolves.toBeNull();
    expect(database.get.mock.calls[0][0]).toContain("status = 'failed'");
    expect(database.get.mock.calls[0][1]).toEqual(["team-a", "delivery-a"]);
  });

  it("terminalizes an expired last-attempt claim before claiming more work", async () => {
    database.get.mockResolvedValueOnce(null);
    await repository.claimNextAny();
    expect(database.run.mock.calls[0][0]).toContain("status = 'failed'");
    expect(database.get.mock.calls[0][0]).toContain("UPDATE domain_event_deliveries");
    expect(database.get.mock.calls[0][0]).toContain("attempt_count < 12");
  });
});
