import { beforeEach, describe, expect, it, vi } from "vitest";

const database = vi.hoisted(() => ({
  all: vi.fn(),
  get: vi.fn(),
  run: vi.fn(),
  transaction: vi.fn(),
}));
vi.mock("./db-client.js", () => ({ default: database }));

import { DomainEventDeliveryRepository } from "./domain-event-delivery-repository.js";

describe("DomainEventDeliveryRepository", () => {
  const repository = new DomainEventDeliveryRepository();
  beforeEach(() => vi.resetAllMocks());

  beforeEach(() => database.transaction.mockResolvedValue(undefined));

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

  it("normalizes persisted fanout and delivery states without exposing error data", async () => {
    database.get.mockResolvedValueOnce({
      status: "repeat",
      delivery_count: 3,
      routing_status: "matched",
    });
    database.all.mockResolvedValueOnce([
      { status: "admitted", last_error: "private" },
      { status: "filtered" },
      { status: "failed" },
      { status: "claimed" },
    ]);
    await expect(repository.getOutcomeProjection("team-a", "event-a")).resolves.toEqual({
      eventId: "event-a",
      fanout: "repeat",
      routingStatus: "matched",
      repeatSemantics: "idempotent-repeat",
      deliveries: [{ status: "accepted" }, { status: "filtered" }, { status: "failed" }, { status: "in-progress" }],
    });
    expect(database.get.mock.calls[0][1]).toEqual(["team-a", "event-a"]);
    expect(database.all.mock.calls[0][1]).toEqual(["team-a", "event-a"]);
  });

  it("keeps unmatched distinct from filtered and returns null for another workspace", async () => {
    database.get.mockResolvedValueOnce({
      status: "unmatched",
      delivery_count: 0,
      routing_status: "unmatched",
    });
    database.all.mockResolvedValueOnce([]);
    await expect(repository.getOutcomeProjection("team-a", "event-a")).resolves.toMatchObject({
      fanout: "unmatched",
      routingStatus: "unmatched",
      deliveries: [],
    });
    database.get.mockResolvedValueOnce(null);
    database.all.mockResolvedValueOnce([]);
    await expect(repository.getOutcomeProjection("team-b", "event-a")).resolves.toBeNull();
    expect(database.get.mock.calls.at(-1)?.[1]).toEqual(["team-b", "event-a"]);
    expect(database.all.mock.calls.at(-1)?.[1]).toEqual(["team-b", "event-a"]);
  });

  it("fans out only currently matching subscriptions and tolerates duplicates", async () => {
    database.get.mockResolvedValueOnce({ sequence: 9, type: "order.created" }).mockResolvedValueOnce({
      status: "matched",
      delivery_count: 1,
      routing_status: "matched",
    });
    await expect(repository.fanout("team-a", "event-a")).resolves.toEqual({
      status: "matched",
      deliveryCount: 1,
      routingStatus: "matched",
    });
    const statements = database.transaction.mock.calls[0][0];
    expect(statements[0].s).toContain("INSERT OR IGNORE");
    expect(statements[0].s).toContain("? > s.high_water_event_sequence");
    expect(statements[0].d).toEqual(["team-a", "event-a", "team-a", "order.created", 9]);
    expect(statements[1].s).toContain("ON CONFLICT(team_id, event_id)");
    expect(statements[1].d).toEqual([
      "team-a",
      "event-a",
      "team-a",
      "event-a",
      "team-a",
      "event-a",
      "team-a",
      "event-a",
    ]);
    expect(database.get.mock.calls[1][1]).toEqual(["team-a", "event-a"]);
  });

  it("records distinct unmatched and repeated fanout outcomes within the workspace", async () => {
    database.get.mockResolvedValueOnce({ sequence: 10, type: "missing.type" }).mockResolvedValueOnce({
      status: "unmatched",
      delivery_count: 0,
      routing_status: "unmatched",
    });
    await expect(repository.fanout("team-a", "event-a")).resolves.toEqual({
      status: "unmatched",
      deliveryCount: 0,
      routingStatus: "unmatched",
    });
    expect(database.transaction.mock.calls[0][0][1].s).toContain("THEN 'matched' ELSE 'unmatched'");
    database.get.mockResolvedValueOnce({ sequence: 10, type: "missing.type" }).mockResolvedValueOnce({
      status: "repeat",
      delivery_count: 0,
      routing_status: "unmatched",
    });
    await expect(repository.fanout("team-a", "event-a")).resolves.toEqual({
      status: "repeat",
      deliveryCount: 0,
      routingStatus: "unmatched",
    });
    expect(database.transaction.mock.calls[0][0][1].s).toContain("status = 'repeat'");
    expect(database.get.mock.calls.at(-1)?.[1]).toEqual(["team-a", "event-a"]);
  });

  it("repairs missing fanout without backfilling events before subscription start", async () => {
    database.get.mockResolvedValueOnce({ count: 3 });
    await expect(repository.reconcileFanout(1000)).resolves.toBe(3);
    const statements = database.transaction.mock.calls[0][0];
    expect(statements[0].s).toContain("e.sequence > s.high_water_event_sequence");
    expect(statements[0].d).toEqual([500]);
    expect(statements[1].s).toContain("INSERT OR IGNORE INTO domain_event_fanout_outcomes");
    expect(statements[1].s).toContain("THEN 'matched' ELSE 'unmatched'");
  });

  it("uses a durable event sequence high-water mark rather than timestamps", async () => {
    database.get.mockResolvedValueOnce({ sequence: 4, type: "order.created" }).mockResolvedValueOnce({
      status: "unmatched",
      delivery_count: 0,
      routing_status: "unmatched",
    });
    await repository.fanout("team-a", "before-subscription");
    expect(database.transaction.mock.calls[0][0][0].d.at(-1)).toBe(4);
    database.get.mockReset();
    database.transaction.mockReset();
    database.transaction.mockResolvedValue(undefined);
    database.get.mockResolvedValueOnce({ sequence: 5, type: "order.created" }).mockResolvedValueOnce({
      status: "matched",
      delivery_count: 1,
      routing_status: "matched",
    });
    await repository.fanout("team-a", "after-subscription");
    expect(database.transaction.mock.calls[0][0][0].d.at(-1)).toBe(5);
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
      invocation_id: "invocation-1",
      last_error: "oops",
      created_at: "now",
      updated_at: "now",
    });
    await expect(
      repository.finish("team-a", "d", 1, {
        status,
        jobIds: ["job"],
        invocationId: status === "admitted" ? "invocation-1" : undefined,
        error: "oops",
      }),
    ).resolves.toMatchObject({
      status,
      jobIds: ["job"],
    });
    if (status === "admitted") {
      expect(database.get.mock.calls[0][0]).toContain("invocation_id = ?");
      expect(database.get.mock.calls[0][1][3]).toBe("invocation-1");
    }
    expect(database.get.mock.calls[0][0]).toContain("AND attempt_count = ?");
    expect(database.get.mock.calls[0][1].slice(5)).toEqual(["team-a", "d", 1]);
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
