import { beforeEach, describe, expect, it, vi } from "vitest";

const { all } = vi.hoisted(() => ({ all: vi.fn() }));

vi.mock("./db-client.js", () => ({ default: { all } }));

import { WorkflowRepository } from "./workflows.js";

describe("active workflow listing", () => {
  beforeEach(() => {
    all.mockReset();
  });

  it("returns source YAML from the enabled published revision only", async () => {
    all.mockResolvedValue([
      {
        id: "published-workflow",
        name: "Published Workflow",
        source_yaml: "name: Published Workflow\nsteps: []",
        revision: 4,
        status: "published",
        enabled: 1,
      },
    ]);

    const workflows = await new WorkflowRepository().listActive();

    expect(all).toHaveBeenCalledWith(
      expect.stringContaining("JOIN workflow_revisions r ON r.workflow_id = w.id AND r.revision = w.active_revision"),
    );
    expect(all.mock.calls[0][0]).toContain("WHERE w.status = 'published' AND w.enabled = 1");
    expect(workflows).toEqual([
      {
        id: "published-workflow",
        name: "Published Workflow",
        sourceYaml: "name: Published Workflow\nsteps: []",
        revision: 4,
        status: "published",
        enabled: true,
      },
    ]);
  });

  it("limits active workflow listing to the owning workspace", async () => {
    all.mockResolvedValue([]);

    await new WorkflowRepository().listActiveForTeam("cloudy");

    expect(all).toHaveBeenCalledWith(expect.stringContaining("WHERE w.team_id = ? AND w.status = 'published'"), [
      "cloudy",
    ]);
  });
});
