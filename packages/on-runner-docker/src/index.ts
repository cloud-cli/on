import { spawn } from "node:child_process";
import type {
  NormalizedStepDefinition,
  StepOutput,
  WorkflowContext,
  WorkflowRunner,
} from "@cloud-cli/on/types";

export const defaultWorkspace = "/workspace";
export const defaultImage = "dhi.io/alpine-base:3.23-alpine3.23-dev";

function interpolate(template: string, context: WorkflowContext): string {
  const keys = Object.keys(context);
  const f = Function(
    "context",
    "const { " + keys.join(", ") + " } = context;return `" + template + "`;",
  );

  return String(f(context) || "");
}

export function prepareDockerStep(
  step: NormalizedStepDefinition,
  context: WorkflowContext,
) {
  const defaults = context.workflow.defaults || {};

  step.image ||= defaults.image || defaultImage;
  step.volumes ||= defaults.volumes || {};
  step.args ||= defaults.args || [];

  return step;
}

export function prepareDockerArgs(
  args: Record<string, string>[],
  context: WorkflowContext,
): string[] {
  return (args || []).flatMap((arg) =>
    Object.entries(arg).flatMap(([key, value]) => [
      `--${key}`,
      interpolate(String(value), context),
    ]),
  );
}

export function prepareDockerVolumes(
  volumes: Record<string, string>,
  context: WorkflowContext,
): string[] {
  volumes["."] ||= defaultWorkspace;
  return Object.entries(volumes).flatMap(([hostPath, containerPath]) => [
    "-v",
    `${hostPath === "." ? context.workingDir : hostPath}:${containerPath}`,
  ]);
}

function prepareDockerShell(
  step: NormalizedStepDefinition,
  context: WorkflowContext,
) {
  const prepared = prepareDockerStep(step, context);
  const { args, image, volumes } = prepared;
  const mappedVolumes = prepareDockerVolumes(volumes, context);
  const mappedArgs = prepareDockerArgs(args, context);
  const workingDir = volumes["."];
  const dockerArgs = [
    "run",
    "-i",
    "--rm",
    ...mappedVolumes,
    ...mappedArgs,
    "-w",
    workingDir,
    "--entrypoint",
    "sh",
    image,
  ] as string[];

  return spawn("docker", dockerArgs, {
    env: context.env,
  });
}

export const dockerRunner: WorkflowRunner<
  NormalizedStepDefinition,
  WorkflowContext,
  StepOutput
> = {
  run(step, context) {
    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    const cmd = interpolate(step.run, context);

    const shell = prepareDockerShell(step, context);

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
