import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { parseWorkflow } from "../src/workflows.js";
import { SafeExpressionEvaluator } from "../src/safe-eval.js";

const source = readFileSync(resolve(process.cwd(), "tests/test.yaml"), "utf8");
const [workflow] = parseWorkflow(source);

describe("workflow-owned GitHub payload migration fixture", () => {
  it("uses an isolated nonlegacy alias with workflow-owned filtering", async () => {
    expect(workflow.id).toBe("github-workflow-migration-fixture");
    expect(workflow.on.provider).toBe("github-test");
    expect(workflow.on.if).toContain("cloud-cli/on-github-workflow-migration-test");
    const context = {
      inputs: {
        request: { headers: { "x-github-event": "push" } },
        body: {
          repository: { full_name: "cloud-cli/on-github-workflow-migration-test" },
          ref: "refs/heads/main",
        },
      },
    };
    expect(await SafeExpressionEvaluator.evaluateConditions(workflow.on.if, context)).toBe(true);
    expect(
      await SafeExpressionEvaluator.evaluateConditions(workflow.on.if, {
        inputs: { ...context.inputs, request: { headers: { "x-github-event": "ping" } } },
      }),
    ).toBe(false);
    expect(
      await SafeExpressionEvaluator.evaluateConditions(workflow.on.if, {
        inputs: { ...context.inputs, body: { ...context.inputs.body, repository: { full_name: "someone/else" } } },
      }),
    ).toBe(false);
    expect(
      await SafeExpressionEvaluator.evaluateConditions(workflow.on.if, {
        inputs: { ...context.inputs, body: { ...context.inputs.body, ref: "refs/heads/feature" } },
      }),
    ).toBe(false);
    expect(
      await SafeExpressionEvaluator.evaluateConditions(workflow.on.if, {
        inputs: { event: "push", body: {} },
      }),
    ).toBe(false);
  });

  it("normalizes representative payload values and safely defaults missing fields", async () => {
    const context = {
      inputs: {
        request: { headers: { "x-github-event": "push" } },
        body: {
          repository: { full_name: "cloud-cli/on-github-workflow-migration-test" },
          ref: "refs/heads/main",
          after: "abc123",
          head_commit: { message: "Migration fixture commit" },
        },
      },
    };
    const normalizeStep = workflow.steps.find((step) => step.id === "report-payload")!;
    expect(await SafeExpressionEvaluator.evaluateExpression(normalizeStep.eval!, context)).toEqual({
      event: "push",
      repository: "cloud-cli/on-github-workflow-migration-test",
      owner: "cloud-cli",
      repo: "on-github-workflow-migration-test",
      ref: "refs/heads/main",
      branch: "main",
      commit_sha: "abc123",
      commit_message: "Migration fixture commit",
    });
    const missing = await SafeExpressionEvaluator.evaluateExpression(normalizeStep.eval!, { inputs: {} });
    expect(missing).toEqual({
      event: "",
      repository: "",
      owner: "",
      repo: "",
      ref: "",
      branch: "",
      commit_sha: "",
      commit_message: "",
    });
  });

  it("uses only a workspace secret reference for commit statuses", () => {
    expect(source).toContain("${secrets.GITHUB_TOKEN}");
    expect(source).toMatch(/statuses\/\$TEST_SHA/);
    expect(source).not.toMatch(/github-status|SECRET_[A-Z0-9_]+\s*[:=]\s*["'][^$]/i);
    const normalizeStep = workflow.steps.find((step) => step.id === "report-payload");
    expect(normalizeStep).toHaveProperty("eval");
    expect(normalizeStep).not.toHaveProperty("run");
    expect(workflow.post?.[0].run).toContain("CI_JOB_STATUS");
  });
});
