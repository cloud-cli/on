import { describe, expect, it } from "vitest";
import {
  canInsertRecipe,
  commitRecipeInsertion,
  matchesRecipeSearch,
  prepareRecipeInsertion,
} from "./recipe-insertion.mjs";

const recipeRef = "team/docker-build@v3";

describe("safe recipe insertion", () => {
  it("inserts recipe keys into an empty workflow", () => {
    expect(prepareRecipeInsertion("", recipeRef)).toMatchObject({
      safe: true,
      source: "using: team/docker-build@v3\nwith: {}\nsecrets: {}\n",
      replacesSteps: false,
    });
  });

  it("replaces only root steps and preserves other source bytes", () => {
    const source = "name: Build\nmetadata:\n  owner: team\nsteps:\n  - run: npm test\nenabled: true\n";
    const result = prepareRecipeInsertion(source, recipeRef);
    expect(result.safe).toBe(true);
    expect(result.source).toBe(
      "name: Build\nmetadata:\n  owner: team\nusing: team/docker-build@v3\nwith: {}\nsecrets: {}\nenabled: true\n",
    );
    expect(result.replacesSteps).toBe(true);
  });

  it.each([
    ["malformed", "steps:\n  - ["],
    ["root comments", "# keep me\nsteps:\n  - run: x\n"],
    ["step comments", "steps:\n  # preserve me\n  - run: x\n"],
    ["aliases", "defaults: &defaults\n  run: x\nsteps:\n  - *defaults\n"],
    ["recipe-key collision", "using: other/recipe@v1\nsteps:\n  - run: x\n"],
    ["with-key collision", "with: {key: value}\nsteps:\n  - run: x\n"],
    ["secrets-key collision", "secrets: {TOKEN: TOKEN}\nsteps:\n  - run: x\n"],
    ["missing steps", "name: workflow\n"],
  ])("leaves %s input for manual fallback", (_name, source) => {
    expect(prepareRecipeInsertion(source, recipeRef)).toMatchObject({
      safe: false,
      snippet: `using: ${recipeRef}\nwith: {}\nsecrets: {}`,
    });
  });

  it("searches recipe name, namespace, and slug without case sensitivity", () => {
    const recipe = { name: "Docker build", namespace: "team", slug: "docker-build" };
    expect(matchesRecipeSearch(recipe, "DOCKER")).toBe(true);
    expect(matchesRecipeSearch(recipe, "TEAM")).toBe(true);
    expect(matchesRecipeSearch(recipe, "no match")).toBe(false);
    expect(matchesRecipeSearch(recipe, " ")).toBe(true);
  });

  it("refuses revoked versions for insertion", () => {
    expect(canInsertRecipe({ namespace: "team", slug: "old", version: 1, revoked: true })).toBe(false);
    expect(canInsertRecipe({ namespace: "team", slug: "good", version: 1, revoked: false })).toBe(true);
    expect(canInsertRecipe(null)).toBe(false);
  });

  it("requires confirmation and rejects a draft changed while the picker was open", () => {
    const plan = prepareRecipeInsertion("steps:\n  - run: build\n", recipeRef);
    expect(commitRecipeInsertion("steps:\n  - run: build\n", "steps:\n  - run: build\n", plan, false)).toMatchObject({
      inserted: false,
      needsConfirmation: true,
    });
    expect(commitRecipeInsertion("name: changed\n", "steps:\n  - run: build\n", plan, true)).toMatchObject({
      inserted: false,
      reason: expect.stringContaining("changed"),
    });
    expect(commitRecipeInsertion("steps:\n  - run: build\n", "steps:\n  - run: build\n", plan, true)).toMatchObject({
      inserted: true,
      source: expect.stringContaining(`using: ${recipeRef}`),
    });
  });

  it("inserts into an empty draft without a redundant replacement confirmation", () => {
    const plan = prepareRecipeInsertion("", recipeRef);
    expect(commitRecipeInsertion("", "", plan, false)).toEqual({
      inserted: true,
      source: `using: ${recipeRef}\nwith: {}\nsecrets: {}\n`,
    });
  });
});
