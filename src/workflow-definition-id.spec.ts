import { beforeEach, describe, expect, it, vi } from "vitest";

const database = vi.hoisted(() => ({ all: vi.fn(), get: vi.fn(), run: vi.fn(), exec: vi.fn(), transaction: vi.fn() }));
vi.mock("./db-client.js", () => ({ default: database }));

import { WorkflowRepository } from "./workflows.js";

const sourceYaml = (id = "release-pipeline") => `id: ${id}\nname: Release\non: {}\nsteps: [{ run: 'true' }]\n`;

describe("workflow definition IDs", () => {
  beforeEach(() => {
    vi.resetAllMocks();
    database.transaction.mockResolvedValue([]);
  });

  it("persists the editable YAML identity independently from the management key", async () => {
    database.get
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce({ revision: 0 })
      .mockResolvedValueOnce({ team_id: "team-a" });
    database.all.mockResolvedValue([]);

    const saved = await new WorkflowRepository().saveDraftForTeam("team-a", "record-key", sourceYaml());

    expect(saved.id).toBe("record-key");
    const statements = database.transaction.mock.calls[0][0];
    expect(statements[0].d[0]).toBe("record-key");
    expect(statements[1].d[0]).toBe("record-key");
    expect(JSON.parse(statements[1].d[3]).id).toBe("release-pipeline");
  });

  it("rejects a definition ID already used by another workflow in the same workspace", async () => {
    database.get.mockResolvedValueOnce(null);
    database.all.mockResolvedValue([{ id: "other-record", definition_id: "release-pipeline" }]);

    await expect(new WorkflowRepository().saveDraftForTeam("team-a", "record-key", sourceYaml())).rejects.toThrow(
      'Workflow id "release-pipeline" already exists in this workspace',
    );
    expect(database.transaction).not.toHaveBeenCalled();
  });

  it("allows editing the workflow ID without conflicting with its own previous revisions", async () => {
    database.get
      .mockResolvedValueOnce({ team_id: "team-a" })
      .mockResolvedValueOnce({ revision: 1 })
      .mockResolvedValueOnce({ team_id: "team-a" });
    database.all.mockResolvedValue([{ id: "record-key", definition_id: "release-pipeline" }]);

    const saved = await new WorkflowRepository().saveDraftForTeam("team-a", "record-key", sourceYaml("release-v2"));
    expect(saved).toMatchObject({ id: "record-key", revision: 2 });
    expect(JSON.parse(database.transaction.mock.calls[0][0][1].d[3]).id).toBe("release-v2");
  });
});
