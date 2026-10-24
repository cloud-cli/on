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
      "only inputs, steps, and functions",
    );
    expect(() => parseRecipe("inputs: {type: object}\nsteps: [{using: ns/recipe@v1}]\n")).toThrow("Nested recipe");
  });

  it("normalizes legacy recipes to main and parses named functions", () => {
    const legacy = parseRecipe("inputs: {type: object}\nsteps: [{run: echo hi}]\n");
    expect(legacy.functions.main).toMatchObject({ inputs: legacy.inputs, steps: legacy.steps });
    const parsed = parseRecipe(
      `functions:\n  build:\n    inputs: {type: object}\n    outputs: {type: object}\n    steps: [{run: echo build}]\n  test:\n    inputs: {type: object}\n    outputs: {type: object}\n    steps: [{run: echo test}]\n`,
    );
    expect(Object.keys(parsed.functions)).toEqual(["build", "test"]);
    expect(parsed.functions.build.steps).toHaveLength(1);
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
