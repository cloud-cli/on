import { spawn } from "node:child_process";
import { getStepOutput } from "@cloud-cli/on-devkit";
import type { StepDefinition, WorkflowContext } from "@cloud-cli/on/types";

const SHELL = process.env.SHELL || "sh";

export function run(step: StepDefinition, context: WorkflowContext) {
  const shell = spawn(SHELL, {
    shell: true,
    env: context.env,
    cwd: step.workingDir || context.workingDir || process.cwd(),
  });

  const cmd = step.run + "\nexit $?;\n";

  return getStepOutput(cmd, shell);
}
