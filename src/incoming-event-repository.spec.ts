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
});
