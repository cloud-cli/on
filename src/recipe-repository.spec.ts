import { beforeEach, describe, expect, it, vi } from "vitest";

const database = vi.hoisted(() => ({
  get: vi.fn(),
  all: vi.fn(),
  run: vi.fn(),
  exec: vi.fn(),
  transaction: vi.fn(),
}));
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
      "inputs: { image: { type: string, required: true } }\nsecrets: { credential: { type: file } }\nenv: { IMAGE: '\${inputs.image}' }\nsteps: [{ run: 'npm run deploy' }]\n",
    );
    expect(recipe.version).toBe(2);
    expect(publishId).toMatch(/^[0-9a-f-]{36}$/);
    const statements = database.transaction.mock.calls[0][0];
    const versionInsert = statements.find((statement: { s: string }) =>
      statement.s.includes("INSERT INTO recipe_versions"),
    );
    expect(versionInsert.s).toContain("MAX(version)");
    expect(versionInsert.s).toContain("owner_subject=?");
    expect(JSON.parse(versionInsert.d[9] as string)).toEqual({
      main: {
        inputs: {
          type: "object",
          properties: { image: { type: "string" } },
          required: ["image"],
        },
        secrets: { credential: { type: "file" } },
        outputs: { type: "object" },
        steps: [{ run: "npm run deploy" }],
      },
    });
    expect(JSON.parse(versionInsert.d[7] as string)).toMatchObject({
      properties: { image: { type: "string" } },
      required: ["image"],
    });
    expect(JSON.parse(versionInsert.d[10] as string)).toEqual({
      IMAGE: "${inputs.image}",
    });
    expect(recipe.functions).toEqual(JSON.parse(versionInsert.d[9] as string));
    expect(recipe.env).toEqual({ IMAGE: "${inputs.image}" });
  });

  it("adds functions_json to existing installations and normalizes legacy rows on read", async () => {
    database.all.mockResolvedValue([]);
    const repository = new RecipeRepository();
    await repository.init();
    expect(database.exec).toHaveBeenCalledWith("ALTER TABLE recipe_versions ADD COLUMN functions_json TEXT");
    expect(database.exec).toHaveBeenCalledWith(
      "ALTER TABLE recipe_versions ADD COLUMN env_json TEXT NOT NULL DEFAULT '{}'",
    );

    database.get.mockResolvedValue({
      namespace: "ada",
      slug: "legacy",
      version: 1,
      name: "Legacy",
      source_yaml: "",
      revoked: 0,
      inputs_json: '{"type":"object","properties":{}}',
      steps_json: '[{"run":"echo hi"}]',
      functions_json: null,
    });
    await expect(repository.get("ada", "legacy", 1)).resolves.toMatchObject({
      functions: {
        main: {
          inputs: { type: "object", properties: {} },
          outputs: { type: "object" },
          steps: [{ run: "echo hi" }],
        },
      },
    });
  });

  it("returns persisted named functions from list and get", async () => {
    const functions = {
      deploy: {
        inputs: { type: "object" },
        outputs: { type: "object" },
        steps: [{ run: "deploy" }],
      },
    };
    const row = {
      namespace: "ada",
      slug: "named",
      version: 1,
      name: "Named",
      source_yaml: "",
      revoked: 0,
      inputs_json: '{"type":"object"}',
      steps_json: '[{"run":"deploy"}]',
      functions_json: JSON.stringify(functions),
    };
    database.all.mockResolvedValue([row]);
    database.get.mockResolvedValue(row);
    const repository = new RecipeRepository();
    await expect(repository.list()).resolves.toMatchObject([{ functions }]);
    await expect(repository.get("ada", "named", 1)).resolves.toMatchObject({
      functions,
    });
  });
});
