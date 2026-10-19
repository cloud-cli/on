import { beforeEach, describe, expect, it, vi } from "vitest";

const database = vi.hoisted(() => ({ get: vi.fn(), run: vi.fn(), all: vi.fn(), transaction: vi.fn() }));
vi.mock("./db-client.js", () => ({ default: database }));

import { SecretRepository } from "./secret-repository.js";

describe("workspace secret rotation log scrubbing", () => {
  beforeEach(() => {
    vi.resetAllMocks();
    process.env.RUNNER_MASTER_KEY = "test-secret-rotation-key";
    database.transaction.mockResolvedValue([]);
  });

  it("scrubs old plaintext from that workspace's logs and reports atomically before replacing", async () => {
    const repository = new SecretRepository();
    database.get.mockResolvedValue({ ciphertext: repository.encryptValue("old-secret-value"), encoding: "utf8" });

    await repository.setForTeam("team-a", "DEPLOY_TOKEN", "new-secret-value");

    const statements = database.transaction.mock.calls[0][0];
    expect(statements).toHaveLength(5);
    expect(statements[0].s).toContain("UPDATE step_logs");
    expect(statements[0].s).toContain("SELECT id FROM jobs WHERE team_id = ?");
    expect(statements[0].d).toEqual(["old-secret-value", "team-a", "old-secret-value"]);
    expect(statements[1].s).toContain("UPDATE jobs SET report = replace(report");
    expect(statements[1].d).toEqual(["old-secret-value", "team-a", "old-secret-value"]);
    expect(statements.at(-1).s).toContain("INSERT INTO team_secrets");
    expect(statements.at(-1).d.slice(0, 2)).toEqual(["team-a", "DEPLOY_TOKEN"]);
  });

  it("scrubs base64 secret bytes and escaped report values on deletion", async () => {
    const repository = new SecretRepository();
    const bytes = Buffer.from("rotated-bytes");
    database.get.mockResolvedValue({ ciphertext: repository.encryptValue(bytes.toString("utf8")), encoding: "utf8" });

    await repository.deleteForTeam("team-b", "DEPLOY_TOKEN");

    const statements = database.transaction.mock.calls[0][0];
    const scrubParams = statements.slice(0, -1).map((statement: any) => statement.d);
    expect(scrubParams).toContainEqual(["rotated-bytes", "team-b", "rotated-bytes"]);
    expect(scrubParams).toContainEqual([bytes.toString("base64"), "team-b", bytes.toString("base64")]);
    expect(statements.at(-1).s).toBe("DELETE FROM team_secrets WHERE team_id = ? AND name = ?");
    expect(statements.at(-1).d).toEqual(["team-b", "DEPLOY_TOKEN"]);
  });

  it("fails closed when atomic transactions are unavailable", async () => {
    const repository = new SecretRepository();
    database.get.mockResolvedValue({ ciphertext: repository.encryptValue("old-secret-value"), encoding: "utf8" });
    database.transaction = undefined;

    await expect(repository.deleteForTeam("team-a", "DEPLOY_TOKEN")).rejects.toThrow("Atomic transactions");
    expect(database.run).not.toHaveBeenCalled();
  });
});
