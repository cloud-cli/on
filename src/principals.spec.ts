import { beforeEach, describe, expect, it, vi } from "vitest";
import crypto from "node:crypto";

const db = vi.hoisted(() => ({ all: vi.fn(), get: vi.fn(), run: vi.fn(), exec: vi.fn(), transaction: vi.fn() }));
vi.mock("./db-client.js", () => ({ default: db }));
import { memberViewForCaller, PrincipalRepository } from "./principals.js";

const repo = () => new PrincipalRepository();
const person = (subject = "human", values: any = {}) => ({
  subject,
  name: "Name",
  role: "admin",
  kind: "human",
  disabled_at: null,
  ...values,
});
const tokenDigest = (token: string) => crypto.createHash("sha256").update(token).digest("hex");

describe("PrincipalRepository", () => {
  beforeEach(() => {
    vi.resetAllMocks();
    db.transaction = vi.fn();
    db.run.mockResolvedValue({ changes: 1 });
    db.transaction.mockResolvedValue(undefined);
  });

  it("normalizes principal kind, platform role, and disabled state", async () => {
    db.get
      .mockResolvedValueOnce(person())
      .mockResolvedValueOnce(person("system:x", { kind: "system", disabled_at: "today" }));
    expect(await repo().principal("human")).toMatchObject({ kind: "human", platformRole: "admin", disabled: false });
    expect(await repo().principal("system:x")).toMatchObject({
      kind: "system",
      platformRole: "user",
      platformCapabilities: [],
      disabled: true,
    });
    db.get.mockResolvedValueOnce(person("agent_job-runner", { role: "admin" }));
    expect(await repo().principal("agent_job-runner")).toMatchObject({ kind: "agent", platformRole: "user" });
  });

  it("hashes token lookups, rejects invalid/disabled tokens, and records use", async () => {
    const r = repo();
    expect(await r.tokenPrincipal("")).toBeNull();
    expect(await r.tokenPrincipal("x".repeat(201))).toBeNull();
    expect(db.get).not.toHaveBeenCalled();
    db.get.mockResolvedValueOnce({ ...person(), token_id: "tok" });
    expect(await r.tokenPrincipal("secret-token")).toMatchObject({ subject: "human" });
    expect(db.get.mock.calls[0][1]).toEqual([tokenDigest("secret-token")]);
    expect(db.get.mock.calls[0][1]).not.toContain("secret-token");
    expect(db.run).toHaveBeenCalledWith(expect.stringContaining("last_used_at"), ["tok"]);
    db.get.mockResolvedValueOnce({ ...person(), token_id: "disabled", disabled_at: "now" });
    expect(await r.tokenPrincipal("disabled-token")).toBeNull();
    db.run.mockClear();
    db.get.mockResolvedValueOnce({ ...person("system:legacy", { kind: "system" }), token_id: "legacy" });
    expect(await r.tokenPrincipal("legacy-system-token")).toBeNull();
    db.get.mockResolvedValueOnce({ ...person("agent_build", { kind: "human" }), token_id: "agent-token" });
    expect(await r.tokenPrincipal("legacy-agent-token")).toBeNull();
    expect(db.run).not.toHaveBeenCalled();
  });

  it("identifies Agent identities in workspace member listings", async () => {
    db.all
      .mockResolvedValueOnce([
        { subject: "agent_runner", name: "Runner", email: null, platform_role: "user", kind: "human", role: "member" },
      ])
      .mockResolvedValueOnce([]);

    await expect(repo().listMembers("workspace")).resolves.toMatchObject([{ kind: "agent", role: "collaborator" }]);
  });

  it("loads membership, handles disabled/non-members, legacy roles and overrides", async () => {
    const r = repo();
    db.get.mockResolvedValueOnce(null);
    expect(await r.membership("t", "x")).toBeNull();
    db.get.mockResolvedValueOnce({ role: "member" }).mockResolvedValueOnce(null);
    expect(await r.membership("t", "x")).toBeNull();
    db.get.mockResolvedValueOnce({ role: "member" }).mockResolvedValueOnce(person("x", { disabled_at: "now" }));
    expect(await r.membership("t", "x")).toBeNull();
    db.get.mockResolvedValueOnce({ role: "member" }).mockResolvedValueOnce(person("x", { role: "user" }));
    db.all.mockResolvedValue([{ capability: "runs.logs", effect: "deny" }]);
    expect(await r.membership("t", "x")).toMatchObject({
      role: "collaborator",
      overrides: [{ capability: "runs.logs", effect: "deny" }],
    });
  });

  it("redacts member details for view-only callers while retaining manager details", () => {
    const member = {
      subject: "oidc|secret",
      name: "Alex",
      email: "alex@example.test",
      kind: "human" as const,
      role: "viewer" as const,
      overrides: [{ capability: "runs.logs" as const, effect: "deny" as const }],
      capabilities: ["runs.view" as const],
      disabled: false,
    };
    expect(memberViewForCaller(member, false)).toEqual({
      name: "Alex",
      kind: "human",
      role: "viewer",
      disabled: false,
    });
    expect(memberViewForCaller(member, true)).toEqual(member);
  });

  it("sets permissions with guards, sanitized overrides and audit", async () => {
    const r = repo();
    db.get.mockResolvedValueOnce(null);
    expect(await r.setMemberPermissions("t", "x", "viewer", [], "a")).toBe("not-found");
    db.get
      .mockResolvedValueOnce({ role: "admin" })
      .mockResolvedValueOnce(person())
      .mockResolvedValueOnce({ role: "admin" });
    expect(await r.setMemberPermissions("t", "x", "viewer", [], "a")).toBe("last-admin");
    db.get
      .mockResolvedValueOnce({ role: "viewer" })
      .mockResolvedValueOnce(person("system:x", { kind: "system", role: "user" }));
    expect(await r.setMemberPermissions("t", "system:x", "admin", [], "a")).toBe("not-found");
    db.get
      .mockResolvedValueOnce({ role: "viewer" })
      .mockResolvedValueOnce(person())
      .mockResolvedValueOnce({ role: "viewer" });
    expect(
      await r.setMemberPermissions(
        "t",
        "x",
        "viewer",
        [
          { capability: "runs.logs", effect: "allow" },
          { capability: "invalid", effect: "deny" },
        ] as any,
        "actor",
      ),
    ).toBe("updated");
    const statements = db.transaction.mock.calls.at(-1)![0];
    expect(
      statements.some(({ s, d }: any) => s.includes("workspace_permission_overrides") && d.includes("runs.logs")),
    ).toBe(true);
    expect(
      db.run.mock.calls.some(
        ([sql, params]) => String(sql).includes("authorization_audit") && params.includes("member.permissions"),
      ),
    ).toBe(true);
  });

  it("requires transactions and guards concurrent last-admin demotions without changing overrides", async () => {
    const r = repo();
    db.get
      .mockResolvedValueOnce({ role: "admin" })
      .mockResolvedValueOnce(person())
      .mockResolvedValueOnce({ role: "admin" });
    db.transaction.mockImplementationOnce(async () => undefined);
    expect(await r.setMemberPermissions("t", "x", "viewer", [{ capability: "runs.logs", effect: "deny" }], "a")).toBe(
      "last-admin",
    );
    const statements = db.transaction.mock.calls[0][0];
    expect(statements[0].s).toContain("SELECT COUNT(*) FROM team_members");
    expect(statements[1].s).toContain("role = ?");
    expect(statements[2].s).toContain("WHERE EXISTS");
    db.transaction = undefined as any;
    db.get.mockResolvedValueOnce({ role: "viewer" }).mockResolvedValueOnce(person());
    await expect(r.setMemberPermissions("t", "x", "viewer", [], "a")).rejects.toThrow(
      "Atomic transactions are required",
    );
  });

  it("adds/removes members with correct outcomes", async () => {
    const r = repo();
    db.get.mockResolvedValueOnce(null);
    expect(await r.addMember("t", "x", "viewer", "a")).toBe("not-found");
    db.get.mockResolvedValueOnce(person("sys", { kind: "system" }));
    expect(await r.addMember("t", "sys", "admin", "a")).toBe("not-found");
    db.get.mockResolvedValueOnce(person()).mockResolvedValueOnce({ present: 1 });
    expect(await r.addMember("t", "x", "viewer", "a")).toBe("exists");
    db.get.mockResolvedValueOnce(person()).mockResolvedValueOnce(null);
    expect(await r.addMember("t", "x", "viewer", "a")).toBe("added");
    db.run.mockResolvedValueOnce({ changes: 1 });
    expect(await r.removeMember("t", "x", "a")).toBe("removed");
    db.run.mockResolvedValueOnce({ changes: 0 });
    db.get.mockResolvedValueOnce({ role: "admin" });
    expect(await r.removeMember("t", "x", "a")).toBe("admin");
    db.run.mockResolvedValueOnce({ changes: 0 });
    db.get.mockResolvedValueOnce(null);
    expect(await r.removeMember("t", "x", "a")).toBe("not-found");
  });
});
