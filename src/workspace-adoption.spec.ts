import { describe, expect, it, vi } from "vitest";
import { adopt, databaseClient, parseArgs } from "../scripts/adopt-default-workspace.mjs";

describe("default workspace adoption command", () => {
  it("uses the database module's explicit transaction operation", async () => {
    const fetch = vi.fn(async () => new Response("[]", { status: 200 }));
    vi.stubGlobal("fetch", fetch);
    try {
      await databaseClient("https://db.example/db~clone/index.mjs").transaction([{ s: "SELECT 1", m: "run" }]);
      expect(fetch).toHaveBeenCalledOnce();
      const payload = JSON.parse(fetch.mock.calls[0][1].body);
      expect(payload.m).toBeUndefined();
      expect(payload.t).toEqual([{ s: "SELECT 1", m: "run" }]);
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("requires an explicit workspace and a single operation mode", () => {
    expect(() => parseArgs([])).toThrow("--workspace-id");
    expect(() => parseArgs(["--workspace-id", "target"])).toThrow("exactly one");
    expect(() => parseArgs(["--workspace-id", "target", "--dry-run", "--apply"])).toThrow("exactly one");
    expect(parseArgs(["--workspace-id", "target", "--dry-run"])).toEqual({ apply: false, workspaceId: "target" });
  });

  it("runs all ownership moves and the marker in one atomic transaction", async () => {
    const transaction = vi.fn(async () => []);
    await adopt(
      { transaction },
      "new-workspace",
      new Set([
        "team_push_subscriptions",
        "workspace_webhooks",
        "team_invitations",
        "runner_team_grants",
        "runner_enrollments",
        "runners",
      ]),
    );

    expect(transaction).toHaveBeenCalledOnce();
    const statements = transaction.mock.calls[0][0];
    const sql = statements.map((statement) => statement.s).join("\n");
    expect(sql).toContain("CREATE TABLE IF NOT EXISTS workspace_adoptions");
    expect(sql).toContain("UPDATE workflows SET team_id = ? WHERE team_id = ?");
    expect(sql).toContain("UPDATE jobs SET team_id = ? WHERE team_id = ?");
    expect(sql).toContain("UPDATE team_secrets SET team_id = ? WHERE team_id = ?");
    expect(sql).toContain("UPDATE api_keys SET team_id = ? WHERE team_id = ?");
    expect(sql).toContain("UPDATE workspace_webhooks SET team_id = ? WHERE team_id = ?");
    expect(sql).toContain("UPDATE runners SET team_id = ? WHERE scope = 'team'");
    expect(sql).toContain("UPDATE runner_enrollments SET team_id = ? WHERE scope = 'team'");
    expect(sql).toContain("INSERT OR IGNORE INTO runner_team_grants (runner_id, team_id, created_by, created_at)");
    expect(sql).toContain("DELETE FROM secrets");
    expect(sql).toContain("DELETE FROM team_members WHERE team_id = ?");
    expect(sql).not.toMatch(
      /DELETE FROM (workflows|jobs|workflow_revisions|scheduled_runs|step_logs|stored_files|api_keys|team_secrets)/,
    );
    expect(statements.at(-1)).toEqual({ s: "DELETE FROM secrets", d: [], m: "run" });
  });

  it("leaves optional tenant tables untouched when an older clone lacks them", async () => {
    const transaction = vi.fn(async () => []);
    await adopt({ transaction }, "new-workspace", new Set());
    const sql = transaction.mock.calls[0][0].map((statement) => statement.s).join("\n");

    expect(sql).not.toContain("workspace_webhooks");
    expect(sql).not.toContain("team_push_subscriptions");
    expect(sql).not.toContain("runner_team_grants");
  });
});
