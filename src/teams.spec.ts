import { beforeEach, describe, expect, it, vi } from "vitest";

const database = vi.hoisted(() => ({ all: vi.fn(), get: vi.fn(), run: vi.fn(), exec: vi.fn() }));
vi.mock("./db-client.js", () => ({ default: database }));
import { TeamRepository } from "./teams.js";

describe("team invitations", () => {
  beforeEach(() => vi.resetAllMocks());

  it("stores only a hash of a random invite token and applies expiry", async () => {
    const result = await new TeamRepository().createInvitation("team-a", "ADA@example.test", "admin");
    expect(result.token).toMatch(/^[A-Za-z0-9_-]{40,}$/);
    const [sql, params] = database.run.mock.calls[0];
    expect(sql).toContain("token_hash");
    expect(params[3]).not.toBe(result.token);
    expect(params[2]).toBe("ada@example.test");
    expect(Date.parse(result.expiresAt)).toBeGreaterThan(Date.now());
  });

  it("rejects wrong or expired email-bound token without granting access", async () => {
    database.get.mockResolvedValue(null);
    expect(await new TeamRepository().acceptInvitation("raw-token", "user-sub", "wrong@example.test")).toBe("invalid");
    expect(database.run).not.toHaveBeenCalled();
    expect(database.get.mock.calls[0][0]).toContain("julianday(expires_at) > julianday('now')");
    expect(database.get.mock.calls[0][0]).toContain("RETURNING team_id");
  });

  it("accepts a valid invitation once, atomically adding membership", async () => {
    database.get.mockResolvedValue({ team_id: "team-a" });
    expect(await new TeamRepository().acceptInvitation("raw-token", "user-sub", "ada@example.test")).toBe("accepted");
    expect(database.get.mock.calls[0][0]).toContain("UPDATE team_invitations");
    expect(database.run).toHaveBeenCalledOnce();
    expect(database.run.mock.calls[0][1]).toEqual(["team-a", "user-sub"]);
  });

  it("allows team admins to remove regular members but protects team admins", async () => {
    const repository = new TeamRepository();
    database.get.mockResolvedValueOnce({ role: "admin" }).mockResolvedValueOnce({ role: "member" });
    database.run.mockResolvedValue({ changes: 1 });

    await expect(repository.removeMember("team-a", "admin-1")).resolves.toBe("admin");
    expect(database.run).not.toHaveBeenCalled();
    await expect(repository.removeMember("team-a", "member-1")).resolves.toBe("removed");
    expect(database.run).toHaveBeenCalledWith(
      "DELETE FROM team_members WHERE team_id = ? AND subject = ? AND role = 'member'",
      ["team-a", "member-1"],
    );
  });
});
