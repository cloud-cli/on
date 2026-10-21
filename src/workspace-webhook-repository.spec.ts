import { beforeEach, describe, expect, it, vi } from "vitest";

const database = vi.hoisted(() => ({ all: vi.fn(), get: vi.fn(), run: vi.fn(), exec: vi.fn() }));
vi.mock("./db-client.js", () => ({ default: database }));

import { WorkspaceWebhookRepository } from "./workspace-webhook-repository.js";

describe("WorkspaceWebhookRepository", () => {
  let secrets: { encryptValue: ReturnType<typeof vi.fn>; decryptValue: ReturnType<typeof vi.fn> };
  let repository: WorkspaceWebhookRepository;

  beforeEach(() => {
    vi.resetAllMocks();
    secrets = { encryptValue: vi.fn((value: string) => `encrypted:${value}`), decryptValue: vi.fn((value: string) => value.slice(10)) };
    repository = new WorkspaceWebhookRepository(secrets as any);
  });

  it("creates tokens while persisting only their digest and encrypted signing secret", async () => {
    database.get.mockResolvedValue({ created_at: "now" });
    const record = await repository.create("workspace-a", "github");
    const insert = database.run.mock.calls[0];
    expect(record.token).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(record.signingSecret).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(insert[1][3]).not.toBe(record.token);
    expect(insert[1][3]).toMatch(/^[a-f0-9]{64}$/);
    expect(insert[1][4]).toBe(`encrypted:${record.signingSecret}`);
    expect(secrets.encryptValue).toHaveBeenCalledWith(record.signingSecret);
  });

  it("rejects invalid provider slugs before writing", async () => {
    await expect(repository.create("workspace-a", "GitHub")).rejects.toThrow("lowercase slug");
    expect(database.run).not.toHaveBeenCalled();
  });

  it("lists metadata only and resolves a token to its workspace/provider/signing secret", async () => {
    const registration = { id: "id", workspaceId: "workspace-a", provider: "github", createdAt: "now" };
    database.all.mockResolvedValue([registration]);
    expect(await repository.list("workspace-a")).toEqual([registration]);
    database.get.mockResolvedValue({ team_id: "workspace-a", provider: "github", signing_secret: "encrypted:secret-value" });
    expect(await repository.lookupByToken("abc")).toEqual({
      workspaceId: "workspace-a",
      provider: "github",
      signingSecret: "secret-value",
    });
    expect(secrets.decryptValue).toHaveBeenCalledWith("encrypted:secret-value");
    expect(database.get.mock.calls[0][1][0]).toMatch(/^[a-f0-9]{64}$/);
  });

  it("revokes only within the requested workspace and deletes the encrypted secret", async () => {
    database.run.mockResolvedValue({ changes: 1 });
    expect(await repository.revoke("workspace-a", "id")).toBe(true);
    expect(database.run.mock.calls[0][1]).toEqual(["workspace-a", "id"]);
  });
});
