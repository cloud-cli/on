import { beforeEach, describe, expect, it, vi } from "vitest";

const database = vi.hoisted(() => ({ all: vi.fn(), get: vi.fn(), run: vi.fn() }));
vi.mock("./db-client.js", () => ({ default: database }));

import { AgentWorkflowGrantRepository } from "./agent-workflow-grant-repository.js";

describe("AgentWorkflowGrantRepository", () => {
  const repository = new AgentWorkflowGrantRepository();

  beforeEach(() => vi.resetAllMocks());

  it("lists metadata within one workspace and optionally filters by agent", async () => {
    database.all.mockResolvedValue([
      {
        team_id: "workspace-a",
        agent_principal_id: "agent:build",
        workflow_id: "build",
        granted_by: "human:admin",
        created_at: "2026-01-01 00:00:00",
      },
    ]);

    await expect(repository.list("workspace-a", "agent:build")).resolves.toEqual([
      {
        teamId: "workspace-a",
        agentPrincipalId: "agent:build",
        workflowId: "build",
        grantedBy: "human:admin",
        createdAt: "2026-01-01 00:00:00",
      },
    ]);
    expect(database.all.mock.calls[0][1]).toEqual(["workspace-a", "agent:build"]);
    expect(database.all.mock.calls[0][0]).not.toContain("source_yaml");
  });

  it("inserts grants idempotently and scopes revocation to the workspace", async () => {
    await repository.grant("workspace-a", "agent:build", "build", "human:admin");
    expect(database.run.mock.calls[0][0]).toContain("INSERT OR IGNORE");
    expect(database.run.mock.calls[0][1]).toEqual(["workspace-a", "agent:build", "build", "human:admin"]);

    await repository.revoke("workspace-a", "agent:build", "build");
    expect(database.run.mock.calls[1][1]).toEqual(["workspace-a", "agent:build", "build"]);
  });
});
