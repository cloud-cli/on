import { describe, expect, it } from "vitest";
import { createStepAttemptSnapshot } from "./step-attempt-snapshot.js";

describe("step attempt snapshots", () => {
  it("captures allowlisted execution evidence without secrets, environment or write-only values", () => {
    expect(
      createStepAttemptSnapshot({
        inputs: { branch: "main", deployKey: "hidden" },
        priorSteps: {
          build: { status: "success", outputs: { artifact: "dist.tgz", apiToken: "hidden" } },
        },
        outputs: { published: true, password: "hidden" },
        writeOnlyInputNames: ["deployKey"],
      }),
    ).toEqual({
      version: 1,
      status: "captured",
      inputs: { branch: "main" },
      priorSteps: { build: { status: "success", outputs: { artifact: "dist.tgz" } } },
      outputs: { published: true },
    });
  });

  it("omits a snapshot rather than truncating evidence when it exceeds the storage budget", () => {
    expect(createStepAttemptSnapshot({ inputs: { payload: "x".repeat(70_000) }, priorSteps: {}, outputs: {} })).toEqual(
      { version: 1, status: "omitted", reason: "too_large" },
    );
  });
});
