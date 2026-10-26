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
  beforeEach(() => {
    vi.resetAllMocks();
    database.all.mockResolvedValue([]);
    database.get.mockResolvedValue(null);
  });

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

  it("maps workflow-run recovery rows into canonical events for every pagination mode", async () => {
    database.all.mockResolvedValue([{ ...row, sequence: 3 }]);

    for (const args of [[10], [10, 2], [10, 0, 2]] as const) {
      await expect(repository.listWorkflowRunRequests(...args)).resolves.toEqual([
        {
          id: row.id,
          teamId: row.team_id,
          type: row.type,
          schemaVersion: row.schema_version,
          source: row.source,
          occurredAt: row.occurred_at,
          recordedAt: row.recorded_at,
          correlationId: row.correlation_id,
          causationId: row.causation_id,
          idempotencyKey: row.idempotency_key,
          data: { orderId: "o1" },
          sequence: 3,
        },
      ]);
    }
    expect(database.all.mock.calls[0][0]).toContain("source LIKE 'domain-event-delivery/%'");
    expect(database.all.mock.calls[2][0]).toContain("sequence > ? ORDER BY sequence");
    expect(database.all.mock.calls[2][1]).toEqual([2, 10]);
  });

  it("returns workspace-scoped invocation and canonical run state without encrypted request inputs", async () => {
    database.get.mockResolvedValueOnce({
      id: "invocation-1",
      team_id: "team-a",
      recorded_at: "2026-01-01T00:00:00.000Z",
      workflow_id: "deploy",
      revision: 4,
      invocation_id: "invocation-1",
    });
    database.all.mockResolvedValueOnce([
      {
        variant_index: 0,
        admission_status: "admitted",
        error_code: null,
        job_id: 71,
      },
      {
        variant_index: 1,
        admission_status: "failed",
        error_code: "invalid_input",
        job_id: null,
      },
    ]);

    await expect(repository.getWorkflowInvocationForTeam("team-a", "invocation-1")).resolves.toEqual({
      id: "invocation-1",
      teamId: "team-a",
      requestEventId: "invocation-1",
      workflowId: "deploy",
      revision: 4,
      recordedAt: "2026-01-01T00:00:00.000Z",
      variants: [
        { variantIndex: 0, admissionStatus: "admitted", errorCode: null, runId: "71" },
        { variantIndex: 1, admissionStatus: "failed", errorCode: "invalid_input", runId: null },
      ],
    });
    expect(database.get.mock.calls[0][0]).toContain("team_id = ? AND type = 'workflow.run.requested'");
    expect(database.get.mock.calls[0][1]).toEqual(["team-a", "invocation-1", "invocation-1", "invocation-1"]);
    expect(database.all.mock.calls[0][0]).not.toContain("inputsCiphertext");

    database.get.mockResolvedValueOnce(null);
    await expect(repository.getWorkflowInvocationForTeam("team-b", "invocation-1")).resolves.toBeNull();
  });

  it("paginates workflow requests by durable sequence despite tied timestamps and out-of-order IDs", async () => {
    const timestamp = "2025-01-01T00:00:01.000Z";
    const olderSequence = {
      ...row,
      id: "z-event",
      recorded_at: timestamp,
      sequence: 7,
    };
    const laterSequence = {
      ...row,
      id: "a-event",
      recorded_at: timestamp,
      sequence: 8,
    };
    database.all.mockResolvedValueOnce([olderSequence]).mockResolvedValueOnce([laterSequence]);

    const first = await repository.listWorkflowRunRequests(1);
    const second = await repository.listWorkflowRunRequests(1, 0, first[0].sequence);

    expect(first[0]).toMatchObject({ id: "z-event", sequence: 7 });
    expect(second[0]).toMatchObject({ id: "a-event", sequence: 8 });
    expect(database.all.mock.calls[1][0]).toContain("sequence > ? ORDER BY sequence");
    expect(database.all.mock.calls[1][1]).toEqual([7, 1]);
  });

  it("returns null for an event not found in the requested team", async () => {
    database.get.mockResolvedValue(null);
    await expect(repository.getForTeam("team-b", "event-1")).resolves.toBeNull();
  });

  it("looks up an addressed request event by its workspace-scoped idempotency key", async () => {
    database.get.mockResolvedValue(row);
    await expect(repository.getByIdempotencyKey("team-a", "key-1")).resolves.toMatchObject({
      id: "event-1",
      idempotencyKey: "key-1",
    });
    expect(database.get.mock.calls[0][0]).toContain("WHERE team_id = ? AND idempotency_key = ?");
    expect(database.get.mock.calls[0][1]).toEqual(["team-a", "key-1"]);
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

  it("rejects an event ID collision when the idempotency key differs", async () => {
    database.get.mockResolvedValueOnce(null).mockResolvedValueOnce({ ...row, idempotency_key: "other-key" });
    await expect(
      repository.publish("team-a", {
        id: "event-1",
        type: "order.created",
        schemaVersion: 1,
        source: "orders",
        occurredAt: row.occurred_at,
        correlationId: null,
        causationId: null,
        idempotencyKey: "key-1",
        data: { orderId: "o1" },
      }),
    ).rejects.toThrow("idempotency key conflicts");
  });

  it("returns ordered channel event pages and resumes from an opaque scoped cursor", async () => {
    database.all.mockResolvedValueOnce([
      { ...row, sequence: 3 },
      { ...row, id: "event-2", sequence: 4 },
      { ...row, id: "event-3", sequence: 5 },
    ]);
    const first = await repository.listChannelEvents("team-a", "chan-1", 2);
    expect(first.events.map((event) => event.id)).toEqual(["event-1", "event-2"]);
    expect(first.nextCursor).toBeTruthy();
    expect(database.all.mock.calls[0][1]).toEqual(["team-a", "chan-1", 0, 3]);
    expect(database.all.mock.calls[0][0]).toContain("JOIN stream_event_bindings");
    expect(database.all.mock.calls[0][0]).not.toContain("json_extract(data_json");
    database.all.mockResolvedValueOnce([{ ...row, id: "event-3", sequence: 5 }]);
    const next = await repository.listChannelEvents("team-a", "chan-1", 2, first.nextCursor!);
    expect(next.events.map((event) => event.id)).toEqual(["event-3"]);
    expect(next.nextCursor).toBeNull();
    expect(database.all.mock.calls[7][1]).toEqual(["team-a", "chan-1", 4, 3]);
  });

  it("binds canonical events idempotently within a workspace", async () => {
    database.run.mockResolvedValueOnce({ changes: 1 });
    await expect(repository.bindEventToStream("team-a", "stream-a", "event-a")).resolves.toBe(true);
    expect(database.run.mock.calls[0][0]).toContain("e.team_id = ? AND c.id = ? AND e.id = ?");
    expect(database.run.mock.calls[0][1]).toEqual(["team-a", "stream-a", "event-a"]);
    database.run.mockResolvedValueOnce({ changes: 0 });
    database.get.mockResolvedValueOnce({ bound: 1 });
    await expect(repository.bindEventToStream("team-a", "stream-a", "event-a")).resolves.toBe(true);
  });

  it("adds only team and channel scoped message, admitted-run, and resolvable cause links", async () => {
    const event = {
      ...row,
      sequence: 1,
      causation_id: "cause-1",
      data_json: '{"channelId":"chan-1"}',
    };
    database.all
      .mockResolvedValueOnce([event])
      .mockResolvedValueOnce([{ id: "message-a" }])
      .mockResolvedValueOnce([{ id: "job-7" }])
      .mockResolvedValueOnce([{ id: "invoke-7" }]);
    database.get.mockResolvedValueOnce({
      ...row,
      id: "cause-1",
      team_id: "team-a",
    });
    const page = await repository.listChannelEvents("team-a", "chan-1");
    expect(page.events[0].links).toEqual({
      messageIds: ["message-a"],
      invocationIds: ["invoke-7"],
      runIds: ["job-7"],
      causationEventId: "cause-1",
    });
    expect(database.all.mock.calls[1][1]).toEqual(["team-a", "chan-1", "event-1"]);
    expect(database.all.mock.calls[2][1]).toEqual(["team-a", "event-1"]);
    expect(database.all.mock.calls[2][0]).toContain("d.status = 'admitted'");
    expect(database.all.mock.calls[2][0]).toContain("workflow_run_admissions");
    expect(database.all.mock.calls[3][1]).toEqual(["team-a", "event-1"]);
    expect(database.get.mock.calls[0][1]).toEqual(["team-a", "cause-1"]);
  });

  it("returns empty pages and rejects malformed or cross-workspace cursors", async () => {
    database.all.mockResolvedValueOnce([]);
    await expect(repository.listChannelEvents("team-a", "chan-1")).resolves.toEqual({
      events: [],
      nextCursor: null,
      resumeCursor: null,
    });
    await expect(repository.listChannelEvents("team-a", "chan-1", 10, "not-a-cursor")).rejects.toThrow(
      "Invalid event cursor",
    );
    const otherWorkspace = Buffer.from(
      JSON.stringify({
        v: 1,
        teamId: "team-b",
        channelId: "chan-1",
        sequence: 1,
      }),
    ).toString("base64url");
    await expect(repository.listChannelEvents("team-a", "chan-1", 10, otherWorkspace)).rejects.toThrow(
      "Invalid event cursor",
    );
  });

  it("returns a full final page without a continuation cursor", async () => {
    database.all.mockResolvedValueOnce([
      { ...row, sequence: 1 },
      { ...row, id: "event-2", sequence: 2 },
    ]);
    await expect(repository.listChannelEvents("team-a", "chan-1", 2)).resolves.toMatchObject({
      events: [{ id: "event-1" }, { id: "event-2" }],
      nextCursor: null,
    });
  });
});
