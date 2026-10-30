import { beforeEach, describe, expect, it, vi } from "vitest";

const database = vi.hoisted(() => ({ get: vi.fn() }));
vi.mock("./db-client.js", () => ({ default: database }));

import { IncomingEventRepository } from "./incoming-event-repository.js";

describe("IncomingEventRepository", () => {
  beforeEach(() => vi.resetAllMocks());

  it("returns the original workspace-scoped ingress timestamp as ISO UTC", async () => {
    database.get.mockResolvedValue({ received_at: "2026-10-24 13:00:00" });
    await expect(new IncomingEventRepository().receivedAtForTeam("team-a", "receipt-1")).resolves.toBe(
      "2026-10-24T13:00:00.000Z",
    );
    expect(database.get).toHaveBeenCalledWith("SELECT received_at FROM incoming_events WHERE team_id = ? AND id = ?", [
      "team-a",
      "receipt-1",
    ]);
  });

  it("fails closed when receipt time is absent or invalid", async () => {
    database.get.mockResolvedValueOnce(null).mockResolvedValueOnce({ received_at: "not-a-time" });
    const repository = new IncomingEventRepository();
    await expect(repository.receivedAtForTeam("team-a", "missing")).resolves.toBeNull();
    await expect(repository.receivedAtForTeam("team-a", "invalid")).resolves.toBeNull();
  });

  it("returns UTF-8 JSON as text for incoming event details", async () => {
    const bytes = Buffer.from('{"ok":true}', "utf8");
    database.get.mockResolvedValue({
      id: "event-1",
      connector_id: "sample",
      connector_revision: 2,
      received_at: "2026-10-24 13:00:00",
      content_type: "application/json; charset=utf-8",
      payload_ciphertext: "encrypted-payload",
      payload_sha256: "hash",
      payload_bytes: bytes.length,
      validation_status: "valid",
      processing_status: "received",
      queued_jobs: 0,
      job_ids: "[]",
      replay_count: 0,
    });
    const secrets = { decryptValue: () => bytes.toString("base64") };

    const event = await new IncomingEventRepository(secrets as any).getForTeam("team-a", "event-1");

    expect(event?.payload).toBe('{"ok":true}');
    expect(event?.payloadEncoding).toBe("utf8");
    expect(event?.payloadBase64).toBeUndefined();
  });

  it("preserves binary incoming event details as base64 instead of lossy UTF-8", async () => {
    const bytes = Buffer.from([0, 255, 1, 128]);
    database.get.mockResolvedValue({
      id: "event-2",
      connector_id: "sample",
      connector_revision: 2,
      received_at: "2026-10-24 13:00:00",
      content_type: "application/octet-stream",
      payload_ciphertext: "encrypted-payload",
      payload_sha256: "hash",
      payload_bytes: bytes.length,
      validation_status: "valid",
      processing_status: "received",
      queued_jobs: 0,
      job_ids: "[]",
      replay_count: 0,
    });
    const secrets = { decryptValue: () => bytes.toString("base64") };

    const event = await new IncomingEventRepository(secrets as any).getForTeam("team-a", "event-2");

    expect(event?.payload).toBe("");
    expect(event?.payloadEncoding).toBe("base64");
    expect(event?.payloadBase64).toBe(bytes.toString("base64"));
  });
});
