import { beforeEach, describe, expect, it, vi } from "vitest";

const database = vi.hoisted(() => ({ get: vi.fn(), all: vi.fn(), run: vi.fn(), exec: vi.fn(), transaction: vi.fn() }));
vi.mock("./db-client.js", () => ({ default: database }));

import { RecipeRepository } from "./recipes.js";

describe("global recipe repository identity and versioning", () => {
  beforeEach(() => vi.resetAllMocks());

  it("normalizes a preferred username once and retains its namespace after username changes", async () => {
    database.get
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce({ namespace: "ada-lovelace" })
      .mockResolvedValueOnce({ namespace: "ada-lovelace" });
    const repository = new RecipeRepository();
    await expect(repository.getOrCreateNamespace("oidc-subject", "Ada Lovelace")).resolves.toBe("ada-lovelace");
    await expect(repository.getOrCreateNamespace("oidc-subject", "ada-renamed")).resolves.toBe("ada-lovelace");
    expect(database.run).toHaveBeenCalledWith(expect.stringContaining("INSERT INTO recipe_publishers"), [
      "oidc-subject",
      "ada-lovelace",
    ]);
  });

  it("allocates a version transactionally and returns the version tied to this publication", async () => {
    let publishId = "";
    database.transaction.mockImplementation(async (statements: Array<{ s: string; d: unknown[] }>) => {
      const insert = statements.find((statement) => statement.s.includes("INSERT INTO recipe_versions"));
      publishId = String(insert?.d[5]);
    });
    database.get.mockImplementation(async (sql: string) => {
      if (sql.includes("WHERE publish_id")) {
        return { version: 2 };
      }
      if (sql.includes("SELECT owner_subject FROM recipes")) {
        return { owner_subject: "oidc-subject" };
      }
      return null;
    });
    const recipe = await new RecipeRepository().publish(
      "ada-lovelace",
      "deploy",
      "Deploy",
      "oidc-subject",
      "inputs: { type: object, properties: {} }\nsteps: [{ run: 'npm run deploy' }]\n",
    );
    expect(recipe.version).toBe(2);
    expect(publishId).toMatch(/^[0-9a-f-]{36}$/);
    const statements = database.transaction.mock.calls[0][0];
    const versionInsert = statements.find((statement: { s: string }) =>
      statement.s.includes("INSERT INTO recipe_versions"),
    );
    expect(versionInsert.s).toContain("MAX(version)");
    expect(versionInsert.s).toContain("owner_subject=?");
  });
});
