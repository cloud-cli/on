import { beforeEach, describe, expect, it, vi } from "vitest";
import YAML from "yaml";

const database = vi.hoisted(() => ({
  get: vi.fn(),
  all: vi.fn(),
  run: vi.fn(),
  exec: vi.fn(),
  transaction: vi.fn(),
}));
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
    properties: {
      region: { type: "string" },
      token: { type: "string", writeOnly: true },
    },
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
    expect(definition.steps[0].env).toEqual({
      REGION: "${inputs.region}",
      TOKEN: "${secrets.token}",
    });
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
    expect(snapshot._recipeRef).toEqual({
      namespace: "tools",
      slug: "deploy",
      version: 2,
    });
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
        inputs: {
          type: "object",
          properties: { count: { type: "integer" } },
          required: ["count"],
        },
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

  it("pins nested recipe dependencies transitively by exact function revision", async () => {
    const root = recipeRow();
    root.functions_json = JSON.stringify({
      main: {
        inputs: JSON.parse(root.inputs_json),
        outputs: { type: "object" },
        steps: [{ id: "child-call", call: "other/child@1#build", with: {} }],
      },
    });
    const child = {
      ...recipeRow(),
      namespace: "other",
      slug: "child",
      version: 1,
      functions_json: JSON.stringify({
        build: {
          inputs: { type: "object" },
          outputs: {
            type: "object",
            properties: { artifact: { type: "string" } },
            required: ["artifact"],
          },
          returns: { artifact: "${steps.leaf-call.outputs.artifact}" },
          steps: [{ id: "leaf-call", call: "tools/leaf@4#publish", with: {} }],
        },
      }),
    };
    const leaf = {
      ...recipeRow(),
      namespace: "tools",
      slug: "leaf",
      version: 4,
      functions_json: JSON.stringify({
        publish: {
          inputs: { type: "object" },
          outputs: { type: "object" },
          steps: [{ run: "publish" }],
        },
      }),
    };
    database.get.mockImplementation(async (sql: string, values: string[]) => {
      if (sql.includes("recipe_versions")) {
        return values[0] === "tools" && values[1] === "deploy" ? root : values[0] === "other" ? child : leaf;
      }
      if (sql.includes("COALESCE(MAX(revision)")) {
        return { revision: 0 };
      }
      if (sql.includes("SELECT team_id FROM workflows")) {
        return { team_id: "team-a" };
      }
      return null;
    });
    database.all.mockResolvedValue([]);

    const repository = new WorkflowRepository();
    await repository.saveDraftForTeam("team-a", "deploy-flow", source());
    const revisionInsert = database.transaction.mock.calls[0][0][1];
    const snapshot = JSON.parse(revisionInsert.d[3] as string);
    expect(snapshot._pinnedReferences).toEqual([
      { namespace: "other", slug: "child", version: 1, function: "build" },
      { namespace: "tools", slug: "leaf", version: 4, function: "publish" },
    ]);
    expect(snapshot._pinnedRecipeFunctions).toEqual({
      "other/child@1#build": {
        inputs: { type: "object" },
        outputs: {
          type: "object",
          properties: { artifact: { type: "string" } },
          required: ["artifact"],
        },
        returns: { artifact: "${steps.leaf-call.outputs.artifact}" },
        steps: [{ id: "leaf-call", call: "tools/leaf@4#publish", with: {} }],
      },
      "tools/leaf@4#publish": {
        inputs: { type: "object" },
        outputs: { type: "object" },
        steps: [{ run: "publish" }],
      },
    });
  });

  it("validates nested call bindings and preserves the exact output contract", async () => {
    const root = recipeRow();
    root.functions_json = JSON.stringify({
      main: {
        inputs: JSON.parse(root.inputs_json),
        outputs: { type: "object" },
        steps: [
          {
            id: "child",
            call: "other/child@1#build",
            with: { count: 4, label: "${inputs.region}" },
            secrets: { token: "${secrets.token}" },
          },
        ],
      },
    });
    const child = {
      ...recipeRow(),
      namespace: "other",
      slug: "child",
      version: 1,
      functions_json: JSON.stringify({
        build: {
          inputs: {
            type: "object",
            properties: {
              count: { type: "integer" },
              label: { type: "string" },
              token: { type: "string", writeOnly: true },
            },
            required: ["count", "token"],
          },
          outputs: {
            type: "object",
            properties: { artifact: { type: "string" } },
            required: ["artifact"],
          },
          steps: [{ run: "build" }],
        },
      }),
    };
    database.get.mockImplementation(async (sql: string, values: string[]) => {
      if (sql.includes("recipe_versions")) {
        return values[0] === "tools" ? root : child;
      }
      return null;
    });
    const valid = await new WorkflowRepository().validateForSave(source());
    expect((valid[0] as any)._pinnedReferences).toEqual([
      { namespace: "other", slug: "child", version: 1, function: "build" },
    ]);

    const invalid = async (withText: string, secretText = 'secrets: { token: "${secrets.DEPLOY_TOKEN}" }') => {
      const rootFunctions = JSON.parse(root.functions_json!);
      rootFunctions.main.steps[0].with = YAML.parse(withText);
      rootFunctions.main.steps[0].secrets = YAML.parse(secretText);
      root.functions_json = JSON.stringify(rootFunctions);
      await expect(new WorkflowRepository().validateForSave(source())).rejects.toThrow();
    };
    await invalid("with: { count: 4, label: value, extra: true }");
    await invalid("with: { label: value }");
    await invalid("with: { count: nope, label: value }");
    await invalid('with: { count: 4, label: "prefix ${inputs.region}" }');
    await invalid("with: { count: 4, token: leaked, label: value }");
    await invalid('with: { count: 4, label: "${secrets.token}" }');
    await invalid("with: { count: 4, label: value }", 'secrets: { token: "${secrets.NOT_ALLOWED}" }');
    await invalid("with: { count: 4, label: value }", 'secrets: { token: "${inputs.region}" }');
    await invalid("with: { count: 4, label: value }", "secrets: {}");
  });

  it("validates ordinary bindings at every call site to the same pinned function", async () => {
    const root = recipeRow();
    root.functions_json = JSON.stringify({
      main: {
        inputs: JSON.parse(root.inputs_json),
        outputs: { type: "object" },
        steps: [
          { id: "first", call: "other/child@1#build", with: { count: 1 } },
          { id: "second", call: "other/child@1#build", with: { count: "not-an-integer" } },
        ],
      },
    });
    const child = {
      ...recipeRow(),
      namespace: "other",
      slug: "child",
      version: 1,
      functions_json: JSON.stringify({
        build: {
          inputs: {
            type: "object",
            properties: { count: { type: "integer" } },
            required: ["count"],
          },
          outputs: { type: "object" },
          steps: [{ run: "build" }],
        },
      }),
    };
    database.get.mockImplementation(async (sql: string, values: string[]) => {
      if (!sql.includes("recipe_versions")) {
        return null;
      }
      return values[0] === "tools" ? root : child;
    });

    await expect(new WorkflowRepository().validateForSave(source())).rejects.toThrow("should be integer");
  });

  it("rejects a recursive nested recipe dependency graph", async () => {
    const root = recipeRow();
    root.functions_json = JSON.stringify({
      main: {
        inputs: JSON.parse(root.inputs_json),
        outputs: { type: "object" },
        steps: [{ id: "child-call", call: "other/child@1#build", with: {} }],
      },
    });
    const child = {
      ...recipeRow(),
      namespace: "other",
      slug: "child",
      version: 1,
      functions_json: JSON.stringify({
        build: {
          inputs: { type: "object" },
          outputs: { type: "object" },
          steps: [{ id: "root-call", call: "tools/deploy@2#main", with: {} }],
        },
      }),
    };
    database.get.mockImplementation(async (sql: string, values: string[]) => {
      if (sql.includes("recipe_versions")) {
        return values[0] === "other" ? child : root;
      }
      return null;
    });

    await expect(new WorkflowRepository().validateForSave(source())).rejects.toThrow("Recursive call graph");
  });

  it("fails visibly for missing or revoked exact nested recipe versions", async () => {
    const root = recipeRow();
    root.functions_json = JSON.stringify({
      main: {
        inputs: JSON.parse(root.inputs_json),
        outputs: { type: "object" },
        steps: [{ id: "child-call", call: "other/child@1#build", with: {} }],
      },
    });
    const target = {
      ...recipeRow(),
      namespace: "other",
      slug: "child",
      version: 1,
      functions_json: JSON.stringify({
        build: {
          inputs: { type: "object" },
          outputs: { type: "object" },
          steps: [{ run: "build" }],
        },
      }),
    };
    database.get.mockImplementation(async (sql: string, values: string[]) => {
      if (!sql.includes("recipe_versions")) {
        return null;
      }
      if (values[0] === "tools") {
        return root;
      }
      return null;
    });
    await expect(new WorkflowRepository().validateForSave(source())).rejects.toThrow("Nested recipe version not found");

    database.get.mockImplementation(async (sql: string, values: string[]) => {
      if (!sql.includes("recipe_versions")) {
        return null;
      }
      return values[0] === "tools" ? root : { ...target, revoked: 1 };
    });
    await expect(new WorkflowRepository().validateForSave(source())).rejects.toThrow(
      "Nested recipe version has been revoked",
    );
  });

  it("rejects nested call graphs deeper than sixteen levels", async () => {
    const root = recipeRow();
    root.functions_json = JSON.stringify({
      main: {
        inputs: JSON.parse(root.inputs_json),
        outputs: { type: "object" },
        steps: [{ id: "child-call", call: "other/child1@1#build", with: {} }],
      },
    });
    const children = Array.from({ length: 17 }, (_, index) => {
      const slug = `child${index + 1}`;
      const steps =
        index < 16
          ? [
              {
                id: `call-${index + 1}`,
                call: `other/child${index + 2}@1#build`,
                with: {},
              },
            ]
          : [{ run: "finish" }];
      return {
        ...recipeRow(),
        namespace: "other",
        slug,
        version: 1,
        functions_json: JSON.stringify({
          build: {
            inputs: { type: "object" },
            outputs: { type: "object" },
            steps,
          },
        }),
      };
    });
    database.get.mockImplementation(async (sql: string, values: string[]) => {
      if (!sql.includes("recipe_versions")) {
        return null;
      }
      return values[0] === "tools" ? root : children.find((child) => child.slug === values[1]);
    });

    await expect(new WorkflowRepository().validateForSave(source())).rejects.toThrow("depth exceeds maximum of 16");
  });

  it("validates shared function dependencies separately for each secret context", async () => {
    const root = recipeRow();
    const rootInputs = JSON.parse(root.inputs_json);
    rootInputs.properties.otherToken = { type: "string", writeOnly: true };
    root.inputs_json = JSON.stringify(rootInputs);
    root.functions_json = JSON.stringify({
      main: {
        inputs: rootInputs,
        outputs: { type: "object" },
        steps: [
          {
            id: "child-token",
            call: "other/child@1#build",
            with: {},
            secrets: { token: "${secrets.token}" },
          },
          {
            id: "child-other-token",
            call: "other/child@1#build",
            with: {},
            secrets: { otherToken: "${secrets.otherToken}" },
          },
        ],
      },
    });
    const child = {
      ...recipeRow(),
      namespace: "other",
      slug: "child",
      version: 1,
      functions_json: JSON.stringify({
        build: {
          inputs: {
            type: "object",
            properties: {
              token: { type: "string", writeOnly: true },
              otherToken: { type: "string", writeOnly: true },
            },
          },
          outputs: { type: "object" },
          steps: [
            {
              id: "leaf-call",
              call: "other/leaf@1#build",
              with: {},
              secrets: { token: "${secrets.token}" },
            },
          ],
        },
      }),
    };
    const leaf = {
      ...recipeRow(),
      namespace: "other",
      slug: "leaf",
      version: 1,
      functions_json: JSON.stringify({
        build: {
          inputs: {
            type: "object",
            properties: { token: { type: "string", writeOnly: true } },
            required: ["token"],
          },
          outputs: { type: "object" },
          steps: [{ run: "publish" }],
        },
      }),
    };
    database.get.mockImplementation(async (sql: string, values: string[]) => {
      if (!sql.includes("recipe_versions")) {
        return null;
      }
      if (values[0] === "tools") {
        return root;
      }
      return values[1] === "child" ? child : leaf;
    });
    const workflow = source().replace(
      'secrets: { token: "${secrets.DEPLOY_TOKEN}" }',
      'secrets: { token: "${secrets.DEPLOY_TOKEN}", otherToken: "${secrets.OTHER_TOKEN}" }',
    );

    await expect(new WorkflowRepository().validateForSave(workflow)).rejects.toThrow(
      "Invalid nested recipe secret mapping: token",
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
