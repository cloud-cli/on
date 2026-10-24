import { beforeEach, describe, expect, it, vi } from "vitest";

const database = vi.hoisted(() => ({ get: vi.fn(), all: vi.fn(), run: vi.fn(), exec: vi.fn(), transaction: vi.fn() }));
vi.mock("./db-client.js", () => ({ default: database }));

import { WorkflowRepository } from "./workflows.js";

const source = (using = "tools/deploy@v2") =>
  `id: deployment\nname: Deployment\non: { generic: {} }\nusing: ${using}\nwith: { region: eu-west-1 }\nsecrets: { token: "\${secrets.DEPLOY_TOKEN}" }\n`;
const recipeRow = (revoked = 0) => ({
  namespace: "tools",
  slug: "deploy",
  version: 2,
  name: "Deploy",
  source_yaml: "inputs: {}",
  inputs_json: JSON.stringify({
    type: "object",
    properties: { region: { type: "string" }, token: { type: "string", writeOnly: true } },
    required: ["region", "token"],
  }),
  steps_json: JSON.stringify([
    {
      run: 'deploy --region "$REGION" --token "$TOKEN"',
      env: { REGION: "${inputs.region}", TOKEN: "${inputs.token}" },
    },
  ]),
  revoked,
  functions_json: null,
});

describe("workflow recipe pinning", () => {
  beforeEach(() => {
    vi.resetAllMocks();
    database.get.mockImplementation(async (sql: string) => (sql.includes("recipe_versions") ? recipeRow() : null));
  });

  it("resolves the exact immutable version, validates bindings and compiles a pinned snapshot", async () => {
    const [definition] = await new WorkflowRepository().validateForSave(source());
    expect(definition.steps[0].run).toContain("$REGION");
    expect(definition.steps[0].env).toEqual({ REGION: "${inputs.region}", TOKEN: "${secrets.token}" });
    expect((definition.steps[0] as any).__recipeTemplate).toBe(true);
  });

  it("stores compiled steps and exact recipe/input pins in the immutable normalized revision", async () => {
    database.get.mockImplementation(async (sql: string) => {
      if (sql.includes("recipe_versions")) {
        return recipeRow();
      }
      if (sql.includes("SELECT team_id FROM workflows")) {
        return { team_id: "team-a" };
      }
      if (sql.includes("COALESCE(MAX(revision)")) {
        return { revision: 0 };
      }
      return null;
    });
    database.all.mockResolvedValue([]);
    await new WorkflowRepository().saveDraftForTeam("team-a", "deploy-flow", source());
    const revisionInsert = database.transaction.mock.calls[0][0][1];
    const snapshot = JSON.parse(revisionInsert.d[3] as string);
    expect(snapshot._recipeRef).toEqual({ namespace: "tools", slug: "deploy", version: 2 });
    expect(snapshot._recipeInputs).toEqual({ region: "eu-west-1" });
    expect(snapshot.steps[0].env.TOKEN).toBe("${secrets.token}");
    expect(snapshot._recipeSecrets).toEqual({ token: "DEPLOY_TOKEN" });
    expect(snapshot._recipeFunction).toBe("main");
    expect(snapshot._recipeOutputs).toEqual({ type: "object" });
  });

  it("selects named functions, validates their inputs, and retains the pinned version", async () => {
    const row = recipeRow();
    row.functions_json = JSON.stringify({
      release: {
        inputs: JSON.parse(row.inputs_json),
        outputs: { type: "object", properties: { url: { type: "string" } } },
        steps: [{ run: "release" }],
      },
      audit: {
        inputs: { type: "object", properties: { count: { type: "integer" } }, required: ["count"] },
        outputs: { type: "object" },
        steps: [{ run: "audit" }],
      },
    });
    database.get.mockResolvedValue(row);
    const yaml = source().replace("with: { region: eu-west-1 }", "function: release\nwith: { region: eu-west-1 }");
    const [definition] = await new WorkflowRepository().validateForSave(yaml);
    expect(definition.steps[0].run).toBe("release");
    expect((definition as any)._recipeFunction).toBeUndefined();
    await expect(new WorkflowRepository().validateForSave(source())).rejects.toThrow("specify function");
    await expect(new WorkflowRepository().validateForSave(yaml.replace("eu-west-1", "3"))).rejects.toThrow("string");
    await expect(new WorkflowRepository().validateForSave(yaml.replace("release", "absent"))).rejects.toThrow(
      "not found",
    );
  });

  it("rejects malformed, missing, revoked, and invalid input references", async () => {
    const repository = new WorkflowRepository();
    await expect(repository.validateForSave(source("tools/deploy@latest"))).rejects.toThrow("using must be");
    await expect(repository.validateForSave(source().replace("with: { region: eu-west-1 }\n", ""))).rejects.toThrow(
      "require with and secrets",
    );
    await expect(repository.validateForSave(`${source()}steps: [{ run: 'echo legacy' }]`)).rejects.toThrow(
      "either steps or using",
    );
    await expect(repository.validateForSave("id: missing\nname: Missing\non: { generic: {} }\n")).rejects.toThrow(
      "requires at least one step",
    );
    database.get.mockResolvedValue(null);
    await expect(repository.validateForSave(source())).rejects.toThrow("not found");
    database.get.mockResolvedValue(recipeRow(1));
    await expect(repository.validateForSave(source())).rejects.toThrow("revoked");
    database.get.mockResolvedValue(recipeRow());
    await expect(repository.validateForSave(source().replace("eu-west-1", "123"))).rejects.toThrow("string");
  });

  it("rejects unmapped and malformed secret inputs", async () => {
    database.get.mockResolvedValue(recipeRow());
    await expect(
      new WorkflowRepository().validateForSave(
        source().replace('secrets: { token: "${secrets.DEPLOY_TOKEN}" }', "secrets: { token: raw-secret }"),
      ),
    ).rejects.toThrow("secret mapping");
  });
});
