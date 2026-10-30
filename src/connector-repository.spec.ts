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
      source_yaml: "run: |\n  emit('sample.received', {})",
      revision: 1,
      enabled: 1,
      created_at: "now",
      updated_at: "now",
    });
    const sourceYaml = "run: |\n  emit('sample.received', {})";
    const created = await repository.createForWorkspace("ws-a", "deploy", "Deploy", sourceYaml);
    expect(created.token).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(database.run.mock.calls[0][1]).toEqual([
      "ws-a",
      "deploy",
      "Deploy",
      sourceYaml,
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

  it("saves new connector definitions as unpublished drafts without generating a token", async () => {
    const sourceYaml = "run: |\n  emit('sample.received', { value: inputs.value })";
    database.get.mockResolvedValue({
      connector_id: "intake",
      team_id: "ws-a",
      name: "Intake",
      source_yaml: sourceYaml,
      revision: 1,
      enabled: 0,
      published: 0,
      draft_yaml: sourceYaml,
      draft_name: "Intake",
      created_at: "now",
      updated_at: "now",
    });

    const draft = await repository.saveDraft("ws-a", "intake", "Intake", sourceYaml);

    expect(draft).toMatchObject({ id: "intake", enabled: false, published: false, hasDraft: true });
    expect(database.run.mock.calls[0][0]).toContain("VALUES (?, ?, ?, ?, 1, NULL, 0, ?, ?, 0)");
    expect(database.run.mock.calls[0][1]).toEqual(["ws-a", "intake", "Intake", sourceYaml, sourceYaml, "Intake"]);
    expect(database.get).toHaveBeenCalledOnce();
  });

  it("publishes saved drafts, enables ingress, and returns a fresh token only once", async () => {
    const sourceYaml = "run: |\n  emit('sample.received', { value: inputs.value })";
    database.get
      .mockResolvedValueOnce({
        connector_id: "intake",
        team_id: "ws-a",
        name: "Intake",
        source_yaml: sourceYaml,
        revision: 1,
        enabled: 0,
        published: 0,
        draft_yaml: sourceYaml,
        draft_name: "Intake",
        created_at: "now",
        updated_at: "now",
      })
      .mockResolvedValueOnce({
        connector_id: "intake",
        team_id: "ws-a",
        name: "Intake",
        source_yaml: sourceYaml,
        revision: 2,
        enabled: 1,
        published: 1,
        draft_yaml: null,
        draft_name: null,
        created_at: "now",
        updated_at: "now",
      });

    const published = await repository.publishDraft("ws-a", "intake");

    expect(published).toMatchObject({ id: "intake", version: 2, enabled: true, published: true, hasDraft: false });
    expect(published?.token).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(database.run.mock.calls[0][0]).toContain("published = 1, enabled = 1");
    expect(database.run.mock.calls[0][1]).toEqual([
      sourceYaml,
      expect.stringMatching(/^[a-f0-9]{64}$/),
      "ws-a",
      "intake",
    ]);
    expect(database.run.mock.calls[0][1]).not.toContain(published?.token);
  });

  it("requires publication before enablement and creates a replacement token when re-enabled", async () => {
    const unpublished = {
      connector_id: "intake",
      team_id: "ws-a",
      name: "Intake",
      source_yaml: "yaml",
      revision: 1,
      enabled: 0,
      published: 0,
      created_at: "now",
      updated_at: "now",
    };
    database.get.mockResolvedValueOnce(unpublished);
    await expect(repository.setEnabled("ws-a", "intake", true)).rejects.toThrow("Publish this connector");
    expect(database.run).not.toHaveBeenCalled();

    database.get
      .mockResolvedValueOnce({ ...unpublished, published: 1 })
      .mockResolvedValueOnce({ ...unpublished, published: 1, enabled: 1 });
    const enabled = await repository.setEnabled("ws-a", "intake", true);
    expect(enabled?.token).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(database.run.mock.calls[0][1]).toEqual([expect.stringMatching(/^[a-f0-9]{64}$/), "ws-a", "intake"]);
    expect(database.run.mock.calls[0][1]).not.toContain(enabled?.token);
  });

  it("lists and gets only the selected workspace", async () => {
    database.all.mockResolvedValue([]);
    expect(await repository.listForWorkspace("ws-a")).toEqual([]);
    expect(database.all.mock.calls[0][1]).toEqual(["ws-a"]);
    database.get.mockResolvedValue(null);
    expect(await repository.getForWorkspace("ws-b", "deploy")).toBeNull();
    expect(database.get.mock.calls[0][1]).toEqual(["ws-b", "deploy"]);
  });

  it("stores signing secrets encrypted and exposes only a presence boolean in list/get", async () => {
    const encryptValue = vi.fn((value: string) => `ciphertext:${Buffer.from(value).toString("base64")}`);
    repository = new ConnectorRepository({ encryptValue, decryptValue: (value) => value });
    database.run.mockResolvedValue({ changes: 1 });
    database.get.mockResolvedValue({
      connector_id: "deploy",
      team_id: "ws-a",
      name: "Deploy",
      source_yaml: "yaml",
      revision: 1,
      enabled: 1,
      published: 1,
      created_at: "now",
      updated_at: "now",
      signing_secret_ciphertext: "encrypted-value",
    });
    const rotated = await repository.rotateSigningSecret("ws-a", "deploy");
    expect(rotated?.secret).toMatch(/^whsec_[A-Za-z0-9_-]{43}$/);
    expect(database.run.mock.calls[0][1][0]).toBe(`ciphertext:${Buffer.from(rotated!.secret).toString("base64")}`);
    expect(database.run.mock.calls[0][1][0]).not.toBe(rotated?.secret);
    expect(database.run.mock.calls[0][0]).not.toMatch(/webhook_token_hash/i);
    expect(encryptValue).toHaveBeenCalledWith(rotated?.secret);
    expect(rotated?.connector).toMatchObject({ hasSigningSecret: true });
    expect(rotated?.connector).not.toHaveProperty("signingSecret");
  });

  it("preserves signing configuration when disabling while revoking the webhook URL token", async () => {
    database.get
      .mockResolvedValueOnce({
        connector_id: "deploy",
        team_id: "ws-a",
        name: "Deploy",
        source_yaml: "yaml",
        revision: 1,
        enabled: 1,
        published: 1,
        created_at: "now",
        updated_at: "now",
      })
      .mockResolvedValueOnce({
        connector_id: "deploy",
        team_id: "ws-a",
        name: "Deploy",
        source_yaml: "yaml",
        revision: 1,
        enabled: 0,
        published: 1,
        created_at: "now",
        updated_at: "now",
        signing_secret_ciphertext: null,
      });
    await repository.setEnabled("ws-a", "deploy", false);
    expect(database.run.mock.calls[0][0]).not.toContain("signing_secret_ciphertext = NULL");
    expect(database.run.mock.calls[0][0]).toContain("webhook_token_hash = NULL");
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
