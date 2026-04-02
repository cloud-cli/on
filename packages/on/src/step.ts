import { interpolate } from "@cloud-cli/on-devkit";
import type {
  WorkflowContext,
  StepDefinition,
  WorkflowRunner,
} from "./types.js";

export async function runStep(step: StepDefinition, context: WorkflowContext) {
  const cmd = interpolate(step.run, context);
  const preparedStep = { ...step, run: cmd };
  const runner = await loadRunner(context.runner);

  return await runner.run(preparedStep, context);
}
export function normalizeSteps(
  steps: Array<StepDefinition | string>,
): StepDefinition[] {
  return steps.map((step) => {
    if (typeof step === "string") {
      step = { run: step };
    }

    if (typeof step.run !== "string") {
      throw new Error("Each workflow step must have a 'run' command string.");
    }

    return step;
  });
}

export function loadRunner(runner: string): Promise<WorkflowRunner> {
  try {
    return import("@cloud-cli/on-runner-" + runner);
  } catch (error) {
    throw new Error(
      `Failed to load runner "${runner}". Make sure the package "@cloud-cli/on-runner-${runner}" is installed.`,
    );
  }
}
