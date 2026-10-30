import { beforeEach, describe, expect, it, vi } from "vitest";

const database = vi.hoisted(() => ({ all: vi.fn(), get: vi.fn(), run: vi.fn(), exec: vi.fn(), transaction: vi.fn() }));
vi.mock("./db-client.js", () => ({ default: database }));

import { QueueManager } from "./queue.js";
import { SecretRepository } from "./secret-repository.js";
import { WorkflowRepository } from "./workflows.js";

describe("team data isolation queries", () => {
  beforeEach(() => vi.resetAllMocks());

  it("prevents an existing workflow from being reassigned by a different team", async () => {
    database.get.mockResolvedValue({ team_id: "team-b" });
    const workflows = new WorkflowRepository();

    await expect(
      workflows.saveDraftForTeam(
        "team-a",
        "private-flow",
        "id: private-flow\nname: Private\non: {}\nsteps: [{run: 'true'}]",
      ),
    ).rejects.toThrow("Workflow not found");
    expect(database.run).not.toHaveBeenCalled();
  });

  it("filters workflow listings and webhook revisions by the required team", async () => {
    database.all.mockResolvedValue([]);
    const workflows = new WorkflowRepository();

    await workflows.listForTeam("team-a");
    expect(database.all.mock.calls[0][0]).toContain("WHERE team_id = ?");
    expect(database.all.mock.calls[0][1]).toEqual(["team-a"]);

    await workflows.publishedForTeam("team-b");
    expect(database.all.mock.calls[1][0]).toContain("w.team_id = ?");
    expect(database.all.mock.calls[1][1]).toEqual(["team-b"]);
  });

  it("scopes job and artifact lookups to the owning team", async () => {
    database.get.mockResolvedValue({ id: 7, team_id: "team-a" });
    database.all.mockResolvedValue([]);
    const queue = new QueueManager("test");

    await queue.getJobForTeam("team-a", 7);
    expect(database.get.mock.calls[0][0]).toContain("team_id = ? AND id = ?");
    expect(database.get.mock.calls[0][1]).toEqual(["team-a", 7]);

    await queue.getStoredFilesForTeam("team-a", "artifact", 7);
    expect(database.all.mock.calls[0][0]).toContain("WHERE kind = ? AND owner_key = ?");
  });

  it("reads secrets only from the selected team's encrypted namespace", async () => {
    const secrets = new SecretRepository();
    database.all.mockResolvedValue([]);

    await secrets.namesForTeam("team-a");
    expect(database.all.mock.calls[0][0]).toContain("team_id = ?");
    expect(database.all.mock.calls[0][1]).toEqual(["team-a"]);
  });

  it("updates only a workflow's enabled flag without changing publication state", async () => {
    database.transaction.mockResolvedValue(undefined);
    database.get.mockResolvedValue({ present: 1 });
    const workflows = new WorkflowRepository();

    await expect(workflows.setEnabledForTeam("team-a", "flow", false)).resolves.toBe(true);

    const commands = database.transaction.mock.calls[0][0];
    expect(commands[0].s).toContain("SET enabled = ?");
    expect(commands[0].s).not.toContain("status =");
    expect(commands[0].d).toEqual([0, "team-a", "flow"]);
    expect(commands[1].s).toContain("domain_event_subscriptions SET enabled = 0");
  });

  it("moves only unexecuted drafts between explicitly authorized workspace ids", async () => {
    database.run.mockResolvedValue({ changes: 1 });
    const workflows = new WorkflowRepository();

    await expect(workflows.transferDraftForTeam("team-a", "team-b", "flow")).resolves.toBe(true);

    const [sql, params] = database.run.mock.calls[0];
    expect(sql).toContain("team_id = ? AND status = 'draft'");
    expect(sql).toContain("NOT EXISTS (SELECT 1 FROM jobs");
    expect(sql).toContain("NOT EXISTS (SELECT 1 FROM scheduled_runs");
    expect(params).toEqual(["team-b", "flow", "team-a"]);
  });
});
