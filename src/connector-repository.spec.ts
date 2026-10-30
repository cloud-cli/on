import { beforeEach, describe, expect, it, vi } from "vitest";

const database = vi.hoisted(() => ({ all: vi.fn(), get: vi.fn(), run: vi.fn() }));
vi.mock("./db-client.js", () => ({ default: database }));

import { ConnectorRepository } from "./connector-repository.js";

describe("ConnectorRepository", () => {
  let repository: ConnectorRepository;
  beforeEach(() => {
    vi.resetAllMocks();
    repository = new ConnectorRepository();
  });

  it("creates a connector with a random token and persists only its SHA-256 digest", async () => {
    database.get.mockResolvedValue({
      connector_id: "deploy",
      team_id: "ws-a",
      name: "Deploy",
      source_yaml: "steps: []",
      revision: 1,
      enabled: 1,
      created_at: "now",
      updated_at: "now",
    });
    const created = await repository.createForWorkspace("ws-a", "deploy", "Deploy", "steps: []");
    expect(created.token).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(database.run.mock.calls[0][1]).toEqual([
      "ws-a",
      "deploy",
      "Deploy",
      "steps: []",
      expect.stringMatching(/^[a-f0-9]{64}$/),
    ]);
    expect(database.run.mock.calls[0][1]).not.toContain(created.token);
    expect(database.run).toHaveBeenCalledOnce();
  });

  it.each(["Upper", "bad_slug", "-bad", "bad-", "a".repeat(65)])(
    "rejects invalid id %s without database writes",
    async (id) => {
      await expect(repository.createForWorkspace("ws", id, "Name", "yaml")).rejects.toThrow("lowercase slug");
      expect(database.run).not.toHaveBeenCalled();
    },
  );

  it("enforces nonempty bounded name and YAML source", async () => {
    await expect(repository.createForWorkspace("ws", "valid", "  ", "yaml")).rejects.toThrow("name");
    await expect(repository.createForWorkspace("ws", "valid", "n".repeat(201), "yaml")).rejects.toThrow("name");
    await expect(repository.createForWorkspace("ws", "valid", "Name", "")).rejects.toThrow("YAML source");
    await expect(repository.createForWorkspace("ws", "valid", "Name", "x".repeat(256_001))).rejects.toThrow(
      "YAML source",
    );
    expect(database.run).not.toHaveBeenCalled();
  });

  it("updates only within workspace and appends a snapshot at incremented revision", async () => {
    database.run.mockResolvedValueOnce({ changes: 1 });
    database.get.mockResolvedValue({
      connector_id: "deploy",
      team_id: "ws-a",
      name: "New",
      source_yaml: "new: true",
      revision: 2,
      enabled: 1,
      created_at: "now",
      updated_at: "now",
    });
    expect(await repository.updateForWorkspace("ws-a", "deploy", "New", "new: true")).toMatchObject({ version: 2 });
    expect(database.run.mock.calls[0][1]).toEqual(["New", "new: true", "ws-a", "deploy"]);
    expect(database.run).toHaveBeenCalledOnce();
  });

  it("lists and gets only the selected workspace", async () => {
    database.all.mockResolvedValue([]);
    expect(await repository.listForWorkspace("ws-a")).toEqual([]);
    expect(database.all.mock.calls[0][1]).toEqual(["ws-a"]);
    database.get.mockResolvedValue(null);
    expect(await repository.getForWorkspace("ws-b", "deploy")).toBeNull();
    expect(database.get.mock.calls[0][1]).toEqual(["ws-b", "deploy"]);
  });

  it("revokes within workspace and token lookup hashes tokens and omits disabled connectors", async () => {
    database.run.mockResolvedValue({ changes: 1 });
    expect(await repository.revokeForWorkspace("ws-a", "deploy")).toBe(true);
    expect(database.run.mock.calls[0][1]).toEqual(["ws-a", "deploy"]);
    database.get.mockResolvedValue(null);
    expect(await repository.lookupByToken("secret-token")).toBeNull();
    expect(database.get.mock.calls[0][1][0]).toMatch(/^[a-f0-9]{64}$/);
    expect(database.get.mock.calls[0][1][0]).not.toBe("secret-token");
  });
});
