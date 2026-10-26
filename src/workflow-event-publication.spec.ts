import { beforeEach, describe, expect, it, vi } from "vitest";

const database = vi.hoisted(() => ({
  all: vi.fn(),
  get: vi.fn(),
  run: vi.fn(),
  exec: vi.fn(),
  transaction: vi.fn(),
}));
vi.mock("./db-client.js", () => ({ default: database }));

import { WorkflowRepository } from "./workflows.js";

const eventWorkflow = `id: release
name: Release
on:
  events: [release.requested]
steps:
  - run: echo release
`;

describe("workflow event subscriptions", () => {
  beforeEach(() => {
    vi.resetAllMocks();
    database.get
      .mockResolvedValueOnce({ id: "release", name: "Release", source_yaml: eventWorkflow, enabled: 1 })
      .mockResolvedValueOnce({
        id: "release",
        name: "Release",
        source_yaml: eventWorkflow,
        revision: 3,
        status: "published",
        enabled: 1,
      });
    database.all.mockResolvedValue([]);
    database.transaction.mockResolvedValue(undefined);
  });

  it("publishes an exact revision and replaces subscriptions atomically", async () => {
    await expect(new WorkflowRepository().publishForTeam("team-a", "release")).resolves.toMatchObject({
      id: "release",
      revision: 3,
      status: "published",
    });
    const statements = database.transaction.mock.calls[0][0];
    expect(statements).toHaveLength(3);
    expect(statements[0].s).toContain("active_revision = (SELECT MAX(revision)");
    expect(statements[1].s).toContain("SET enabled = 0");
    expect(statements[2].s).toContain("ON CONFLICT(team_id, workflow_id, workflow_revision, event_type)");
    expect(statements[2].s).toContain("json_each(json_extract(wr.normalized_json, '$.eventTypes'))");
    expect(statements[2].s).toContain(
      "SELECT COALESCE(MAX(sequence), 0) FROM domain_events e WHERE e.team_id = w.team_id",
    );
    expect(statements[2].d).toEqual(["team-a", "release"]);
  });

  it("fails closed if transactions are unavailable", async () => {
    database.transaction = undefined;
    await expect(new WorkflowRepository().publishForTeam("team-a", "release")).rejects.toThrow("database transactions");
  });
});
