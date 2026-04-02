import { spawn } from "node:child_process";
import type {
  NormalizedStepDefinition,
  StepOutput,
  WorkflowContext,
  WorkflowRunner,
} from "@cloud-cli/on/types";

const SHELL = process.env.SHELL || "sh";

function interpolate(template: string, context: WorkflowContext): string {
  const keys = Object.keys(context);
  const f = Function(
    "context",
    "const { " + keys.join(", ") + " } = context;return `" + template + "`;",
  );

  return String(f(context) || "");
}

export const shellRunner: WorkflowRunner<
  NormalizedStepDefinition,
  WorkflowContext,
  StepOutput
> = {
  run(step, context) {
    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    const cmd = interpolate(step.run, context);

    const shell = spawn(SHELL, {
      shell: true,
      env: context.env,
      cwd: step.workingDir || context.workingDir,
    });

    shell.stdout?.on("data", (data) => stdout.push(data));
    shell.stderr?.on("data", (data) => stderr.push(data));

    return new Promise<StepOutput>((resolve, reject) => {
      shell.once("error", reject);
      shell.once("exit", (code) => {
        resolve({
          code: code ?? 0,
          cmd,
          stdout: Buffer.concat(stdout).toString("utf-8"),
          stderr: Buffer.concat(stderr).toString("utf-8"),
        });
      });

      shell.stdin?.write(cmd);
      shell.stdin?.write("\nexit $?;\n");
      shell.stdin?.end();
    });
  },
};
