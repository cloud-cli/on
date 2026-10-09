import { beforeEach, describe, expect, it, vi } from "vitest";

const database = vi.hoisted(() => ({ all: vi.fn(), get: vi.fn(), run: vi.fn(), exec: vi.fn() }));
vi.mock("./db-client.js", () => ({ default: database }));

import { ensureTeamDataSchema } from "./team-data-schema.js";

describe("team data schema initialization order", () => {
  beforeEach(() => vi.resetAllMocks());

  it("supports queue initialization before the workflows table exists", async () => {
    database.all.mockResolvedValue([]);

    await expect(ensureTeamDataSchema()).resolves.toBeUndefined();

    expect(database.exec).toHaveBeenCalledOnce();
    expect(database.exec.mock.calls[0][0]).toContain("CREATE TABLE IF NOT EXISTS team_secrets");
    expect(database.exec.mock.calls[0][0]).not.toContain("idx_workflows_team");
    expect(database.run).not.toHaveBeenCalled();
  });

  it("creates team indexes and assigns legacy jobs once both tables exist", async () => {
    database.all
      .mockResolvedValueOnce([{ name: "id" }, { name: "team_id" }])
      .mockResolvedValueOnce([{ name: "id" }, { name: "team_id" }])
      .mockResolvedValueOnce([{ name: "id" }, { name: "team_id" }])
      .mockResolvedValueOnce([{ name: "id" }, { name: "team_id" }]);

    await ensureTeamDataSchema();

    expect(database.exec).toHaveBeenCalledTimes(3);
    expect(database.exec.mock.calls[1][0]).toContain("idx_workflows_team");
    expect(database.exec.mock.calls[2][0]).toContain("idx_jobs_team");
    expect(database.run).toHaveBeenCalledWith(expect.stringContaining("UPDATE jobs SET team_id"));
  });
});
