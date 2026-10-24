import { beforeEach, describe, expect, it, vi } from "vitest";

const database = vi.hoisted(() => ({
  all: vi.fn(),
  get: vi.fn(),
  run: vi.fn(),
}));
vi.mock("./db-client.js", () => ({ default: database }));

import { DomainEventRepository } from "./domain-event-repository.js";

const row = {
  id: "event-1",
  team_id: "team-a",
  type: "order.created",
  schema_version: 1,
  source: "orders",
  occurred_at: "2025-01-01T00:00:00.000Z",
  recorded_at: "2025-01-01T00:00:01.000Z",
  correlation_id: null,
  causation_id: null,
  idempotency_key: "key-1",
  data_json: '{"orderId":"o1"}',
};

describe("DomainEventRepository", () => {
  const repository = new DomainEventRepository();
  beforeEach(() => vi.resetAllMocks());

  it("persists typed event data and returns the canonical stored event", async () => {
    database.get.mockResolvedValueOnce(row);
    const result = await repository.publish("team-a", {
      type: "order.created",
      schemaVersion: 1,
      source: "orders",
      occurredAt: row.occurred_at,
      correlationId: null,
      causationId: null,
      idempotencyKey: "key-1",
      data: { orderId: "o1" },
    });
    expect(result).toEqual({
      id: "event-1",
      teamId: "team-a",
      type: "order.created",
      schemaVersion: 1,
      source: "orders",
      occurredAt: row.occurred_at,
      recordedAt: row.recorded_at,
      correlationId: null,
      causationId: null,
      idempotencyKey: "key-1",
      data: { orderId: "o1" },
    });
    expect(database.run.mock.calls[0][0]).toContain("INSERT OR IGNORE INTO domain_events");
    expect(database.get.mock.calls[0][1]).toEqual(["team-a", "key-1"]);
  });

  it("scopes get and list to a team and parses JSON data", async () => {
    database.get.mockResolvedValue(row);
    database.all.mockResolvedValue([row]);
    expect(await repository.getForTeam("team-a", "event-1")).toMatchObject({
      data: { orderId: "o1" },
    });
    expect(database.get.mock.calls[0][0]).toContain("WHERE team_id = ? AND id = ?");
    expect(await repository.listForTeam("team-a", 500)).toHaveLength(1);
    expect(database.all.mock.calls[0][1]).toEqual(["team-a", 100]);
  });

  it("returns null for an event not found in the requested team", async () => {
    database.get.mockResolvedValue(null);
    await expect(repository.getForTeam("team-b", "event-1")).resolves.toBeNull();
  });

  it("rejects reusing an idempotency key for different event data", async () => {
    database.get.mockResolvedValue(row);
    await expect(
      repository.publish("team-a", {
        type: "order.created",
        schemaVersion: 1,
        source: "orders",
        occurredAt: row.occurred_at,
        correlationId: null,
        causationId: null,
        idempotencyKey: "key-1",
        data: { orderId: "different" },
      }),
    ).rejects.toThrow("idempotency key conflicts");
  });
});
