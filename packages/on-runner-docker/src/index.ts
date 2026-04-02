import { spawn } from "node:child_process";
import { interpolate, getStepOutput } from "@cloud-cli/on-devkit";
import type { StepDefinition, WorkflowContext } from "@cloud-cli/on";

export const defaultWorkspace = "/workspace";

export const defaults = {
  image: "dhi.io/alpine-base:3.23-alpine3.23-dev",
  volumes: {
    ".": defaultWorkspace,
  },
  args: [],
};

export interface DockerStep extends StepDefinition {
  image?: string;
  volumes?: Record<string, string>;
  args?: Array<Record<string, string>>;
}

export function prepareDockerStep(
  step: StepDefinition,
  context: WorkflowContext,
) {
  const workflowDefaults = context.workflow.defaults || {};
  return { ...defaults, ...workflowDefaults, ...step } as Required<DockerStep>;
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

function prepareDockerShell(step: StepDefinition, context: WorkflowContext) {
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

export function run<S extends StepDefinition, W extends WorkflowContext>(
  step: S,
  context: W,
) {
  const shell = prepareDockerShell(step, context);
  return getStepOutput(cmd, shell);
}
