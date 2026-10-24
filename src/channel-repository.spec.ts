import { beforeEach, describe, expect, it, vi } from "vitest";

const database = vi.hoisted(() => ({ all: vi.fn(), get: vi.fn(), run: vi.fn() }));
vi.mock("./db-client.js", () => ({ default: database }));
import { ChannelRepository } from "./channel-repository.js";

describe("ChannelRepository", () => {
  const repository = new ChannelRepository();
  beforeEach(() => vi.resetAllMocks());

  it("creates a team-scoped channel", async () => {
    database.get.mockResolvedValue({ id: "channel", team_id: "team-a", name: "activity", created_at: "now" });
    await expect(repository.createChannel("team-a", "activity", "channel")).resolves.toEqual({
      id: "channel",
      teamId: "team-a",
      name: "activity",
      createdAt: "now",
    });
    expect(database.run).toHaveBeenCalledWith(expect.stringContaining("INSERT INTO channels"), [
      "channel",
      "team-a",
      "activity",
    ]);
  });

  it("stores immutable JSON messages with optional causal references", async () => {
    database.get.mockResolvedValue({
      id: "message",
      team_id: "team-a",
      channel_id: "channel",
      author: "user",
      body_json: '{"text":"hello"}',
      caused_by_event_id: "event",
      caused_by_job_id: 42,
      created_at: "now",
    });
    const result = await repository.appendMessage({
      teamId: "team-a",
      channelId: "channel",
      author: "user",
      body: { text: "hello" },
      causedByEventId: "event",
      causedByJobId: 42,
    });
    expect(result).toMatchObject({ body: { text: "hello" }, causedByEventId: "event", causedByJobId: 42 });
    expect(database.run.mock.calls[0][0]).toContain("INSERT INTO channel_messages");
  });

  it("uses an ascending team/channel-bound opaque cursor and clamps page size", async () => {
    database.all.mockResolvedValue([]);
    await repository.listMessages("team-a", "channel", 500, "cursor-id");
    expect(database.all.mock.calls[0][0]).toContain("ORDER BY rowid ASC LIMIT ?");
    expect(database.all.mock.calls[0][0]).toContain("SELECT cursor.rowid FROM channel_messages AS cursor");
    expect(database.all.mock.calls[0][1]).toEqual([
      "team-a",
      "channel",
      "cursor-id",
      "team-a",
      "channel",
      "cursor-id",
      100,
    ]);
  });

  it("rejects non-JSON-serializable message bodies", async () => {
    await expect(
      repository.appendMessage({ teamId: "t", channelId: "c", author: "a", body: undefined }),
    ).rejects.toThrow("JSON serializable");
  });
});
