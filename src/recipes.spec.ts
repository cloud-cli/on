import { describe, expect, it } from "vitest";
import { parseRecipe, validateRecipeInputs } from "./recipes.js";

describe("recipe documents", () => {
  it("accepts schema and steps without registry identity fields", () => {
    expect(
      parseRecipe("inputs:\n  type: object\n  properties:\n    text: { type: string }\nsteps:\n  - run: echo hi\n")
        .steps,
    ).toHaveLength(1);
  });

  it("rejects identity metadata and nested recipe references", () => {
    expect(() => parseRecipe("id: sample\ninputs: {type: object}\nsteps: [{run: echo hi}]\n")).toThrow(
      "only inputs, secrets, env, steps, and functions",
    );
    expect(() => parseRecipe("inputs: {type: object}\nsteps: [{using: ns/recipe@v1}]\n")).toThrow("Nested recipe");
  });

  it("rejects nested-call timeouts until the runtime can enforce them", () => {
    expect(() =>
      parseRecipe(`functions:
  build:
    inputs: {type: object}
    outputs: {type: object}
    steps: [{id: child, call: other/child@1#build, with: {}, timeoutMs: 1000}]
`),
    ).toThrow("unsupported call fields");
  });

  it("normalizes legacy recipes to main and parses named functions", () => {
    const legacy = parseRecipe("inputs: {type: object}\nsteps: [{run: echo hi}]\n");
    expect(legacy.functions.main).toMatchObject({
      inputs: legacy.inputs,
      steps: legacy.steps,
    });
    const parsed = parseRecipe(
      `env: { TOOL: ready }\nfunctions:\n  build:\n    inputs: {type: object}\n    outputs: {type: object}\n    steps: [{run: echo build}]\n  test:\n    inputs: {type: object}\n    outputs: {type: object}\n    steps: [{run: echo test}]\n`,
    );
    expect(Object.keys(parsed.functions)).toEqual(["build", "test"]);
    expect(parsed.functions.build.steps).toHaveLength(1);
    expect(parsed.env).toEqual({ TOOL: "ready" });
  });

  it("parses separate input and secret declarations plus shared recipe env", () => {
    const parsed = parseRecipe(
      'inputs:\n  image:\n    type: string\n    required: true\n  imageTag:\n    type: string\n    default: latest\nsecrets:\n  serviceToken:\n    type: string\n    required: true\n  credential:\n    type: file\nenv:\n  IMAGE: "${inputs.image}"\nsteps:\n  - id: build\n    run: build\n',
    );
    expect(parsed.functions.main.inputs).toEqual({
      type: "object",
      properties: {
        image: { type: "string" },
        imageTag: { type: "string", default: "latest" },
      },
      required: ["image"],
    });
    expect(parsed.functions.main.secrets).toEqual({
      serviceToken: { type: "string", required: true },
      credential: { type: "file" },
    });
    expect(parsed.env).toEqual({ IMAGE: "${inputs.image}" });
  });

  it("requires mappings for required outputs and rejects undeclared return fields", () => {
    const valid = parseRecipe(`functions:
  build:
    inputs: {type: object}
    outputs:
      type: object
      properties: {digest: {type: string}}
      required: [digest]
    returns:
      digest: "\u0024{steps.publish.outputs.digest}"
    steps: [{id: publish, run: publish}]
`);
    expect(valid.functions.build.returns).toEqual({
      digest: "${steps.publish.outputs.digest}",
    });

    expect(() =>
      parseRecipe(`functions:
  build:
    inputs: {type: object}
    outputs: {type: object, properties: {digest: {type: string}}, required: [digest]}
    steps: [{run: publish}]
`),
    ).toThrow("must return required output: digest");
    expect(() =>
      parseRecipe(`functions:
  build:
    inputs: {type: object}
    outputs: {type: object, properties: {digest: {type: string}}}
    returns: {unknown: "\u0024{steps.publish.outputs.value}"}
    steps: [{id: publish, run: publish}]
`),
    ).toThrow("returns.unknown");
    expect(() =>
      parseRecipe(`functions:
  build:
    inputs: {type: object}
    outputs: {type: object, properties: {digest: {type: string}}}
    returns: {digest: "\u0024{secrets.TOKEN}"}
    steps: [{id: publish, run: publish}]
`),
    ).toThrow("returns.digest");
    expect(() =>
      parseRecipe(`functions:
  build:
    inputs: {type: object}
    outputs: {type: object, properties: {digest: {type: string}}}
    returns: {digest: "prefix \u0024{steps.publish.outputs.value}"}
    steps: [{id: publish, run: publish}]
`),
    ).toThrow("returns.digest");
  });

  it("rejects malformed function sets and invalid function names", () => {
    expect(() => parseRecipe("functions: {}\n")).toThrow("at least one function");
    expect(() => parseRecipe("inputs: {type: object}\nsteps: [{run: hi}]\nfunctions: {}\n")).toThrow("either");
    expect(() =>
      parseRecipe("functions:\n  bad-name: {inputs: {type: object}, outputs: {type: object}, steps: [{run: hi}]}\n"),
    ).toThrow("valid identifier");
    expect(() =>
      parseRecipe("functions:\n  build: {inputs: {type: object}, outputs: {type: string}, steps: [{run: hi}]}\n"),
    ).toThrow("outputs schema must declare type: object");
  });

  it("does not infer cross-recipe cycles from matching local function names", () => {
    const recipe = parseRecipe(`functions:
  main:
    inputs: {type: object}
    outputs: {type: object}
    steps: [{id: build-call, call: external/child@1#build, with: {}}]
  build:
    inputs: {type: object}
    outputs: {type: object}
    steps: [{id: main-call, call: external/child@1#main, with: {}}]
`);
    expect(recipe.functions.main.steps).toHaveLength(1);
  });

  it("validates required, properties, items, enums and additional properties", () => {
    const schema = {
      type: "object",
      required: ["mode", "values"],
      additionalProperties: false,
      properties: {
        mode: { type: "string", enum: ["fast", "safe"] },
        values: { type: "array", items: { type: "integer" } },
      },
    };
    expect(() => validateRecipeInputs(schema, { mode: "fast", values: [1, 2] })).not.toThrow();
    expect(() => validateRecipeInputs(schema, { mode: "other", values: [1] })).toThrow("allowed values");
    expect(() => validateRecipeInputs(schema, { mode: "fast", values: ["1"] })).toThrow("integer");
    expect(() => validateRecipeInputs(schema, { mode: "fast", values: [], other: true })).toThrow(
      "additional properties",
    );
  });

  it("supports standard JSON Schema constraints and schema-valued additionalProperties", () => {
    const schema = {
      type: "object",
      properties: {
        name: { type: "string", minLength: 3, pattern: "^[a-z]+$" },
      },
      additionalProperties: { type: "integer", minimum: 1 },
    };
    expect(() => validateRecipeInputs(schema, { name: "runner", count: 2 })).not.toThrow();
    expect(() => validateRecipeInputs(schema, { name: "ab", count: 2 })).toThrow();
    expect(() => validateRecipeInputs(schema, { name: "Runner", count: 2 })).toThrow();
    expect(() => validateRecipeInputs(schema, { name: "runner", count: 0 })).toThrow();
  });
});
