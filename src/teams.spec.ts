import { beforeEach, describe, expect, it, vi } from "vitest";

const database = vi.hoisted(() => ({ all: vi.fn(), get: vi.fn(), run: vi.fn(), exec: vi.fn(), transaction: vi.fn() }));
vi.mock("./db-client.js", () => ({ default: database }));
import { TeamRepository } from "./teams.js";

describe("team invitations", () => {
  beforeEach(() => {
    vi.resetAllMocks();
    database.transaction.mockResolvedValue([]);
  });

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
    expect(database.get.mock.calls[0][0]).toContain("SELECT id, team_id FROM team_invitations");
  });

  it("accepts a valid invitation once, atomically adding membership", async () => {
    database.get.mockResolvedValueOnce({ id: "invite-1", team_id: "team-a" }).mockResolvedValueOnce({ present: 1 });
    expect(await new TeamRepository().acceptInvitation("raw-token", "user-sub", "ada@example.test")).toBe("accepted");
    const statements = database.transaction.mock.calls[0][0];
    expect(statements).toHaveLength(2);
    expect(statements[0].s).toContain("UPDATE team_invitations SET accepted_at = ?");
    expect(statements[1].s).toContain("INSERT INTO team_members");
    expect(statements[1].s).toContain("accepted_at = ?");
    expect(statements[1].d.slice(0, 3)).toEqual(["team-a", "user-sub", "invite-1"]);
    expect(database.run).not.toHaveBeenCalled();
  });

  it("creates a time-limited invitation bound to an exact OIDC subject", async () => {
    database.get.mockResolvedValue(null);
    const result = await new TeamRepository().createSubjectInvitation("team-a", " auth-agent-sub ", "admin");
    const [sql, params] = database.run.mock.calls[0];

    expect(sql).toContain("INSERT INTO team_subject_invitations");
    expect(sql).toContain("ON CONFLICT(team_id, subject) DO UPDATE");
    expect(params).toEqual([result.id, "team-a", " auth-agent-sub ", result.expiresAt, "admin"]);
    expect(Date.parse(result.expiresAt)).toBeGreaterThan(Date.now());
  });

  it("rejects invitations for existing members and invalid OIDC subjects", async () => {
    database.get.mockResolvedValueOnce({ present: 1 });
    await expect(new TeamRepository().createSubjectInvitation("team-a", "member-sub", "admin")).rejects.toThrow(
      "Workspace member already exists",
    );
    await expect(new TeamRepository().createSubjectInvitation("team-a", "", "admin")).rejects.toThrow(
      "A valid OIDC subject is required",
    );
    expect(database.run).not.toHaveBeenCalled();
  });

  it("consumes pending OIDC subject invitations only for the authenticated subject", async () => {
    await new TeamRepository().acceptSubjectInvitations("auth-agent-sub");
    const statements = database.transaction.mock.calls[0][0];

    expect(statements[0].s).toContain("INSERT INTO team_members");
    expect(statements[0].s).toContain("WHERE subject = ? AND julianday(expires_at) > julianday('now')");
    expect(statements[0].d).toEqual(["auth-agent-sub"]);
    expect(statements[1].s).toContain("member.invitation.accept");
    expect(statements[1].s).toContain("changes() > 0");
    expect(statements[1].d[0]).toBe("auth-agent-sub");
    expect(statements[2].s).toContain("DELETE FROM team_subject_invitations WHERE subject = ?");
    expect(statements[2].d).toEqual(["auth-agent-sub"]);
  });

  it("creates workspace and owner membership atomically", async () => {
    await new TeamRepository().createTeam("  Release  ", "owner");
    const statements = database.transaction.mock.calls[0][0];
    expect(statements).toHaveLength(2);
    expect(statements[0].s).toContain("INSERT INTO teams");
    expect(statements[0].d[1]).toBe("Release");
    expect(statements[1].s).toContain("INSERT INTO team_members");
    expect(statements[1].d[1]).toBe("owner");
  });

  it("fences a workspace before external job files are purged", async () => {
    database.run.mockResolvedValue({ changes: 1 });
    await expect(new TeamRepository().markWorkspaceDeleting("team-a")).resolves.toBe(true);
    expect(database.run.mock.calls[0][0]).toContain("SET deleting_at = COALESCE");
    expect(database.run.mock.calls[0][1]).toEqual(["team-a"]);
  });

  it("deletes run data, workflows, and workspace records in one transaction", async () => {
    database.get.mockResolvedValue({ id: "team-a" });
    await expect(new TeamRepository().deleteWorkspace("team-a")).resolves.toBe(true);

    const statements = database.transaction.mock.calls[0][0];
    const jobDeletion = statements.findIndex(({ s }: { s: string }) => s === "DELETE FROM jobs WHERE team_id = ?");
    const workflowDeletion = statements.findIndex(
      ({ s }: { s: string }) => s === "DELETE FROM workflows WHERE team_id = ?",
    );
    const workspaceDeletion = statements.findIndex(({ s }: { s: string }) => s === "DELETE FROM teams WHERE id = ?");
    expect(jobDeletion).toBeGreaterThan(-1);
    expect(workflowDeletion).toBeGreaterThan(jobDeletion);
    expect(workspaceDeletion).toBeGreaterThan(workflowDeletion);
    expect(statements.find(({ s }: { s: string }) => s.includes("DELETE FROM stored_files"))?.d).toEqual([
      "team-a",
      "team-a",
    ]);
  });
});
