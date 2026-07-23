import { spawn, execSync } from "node:child_process";
import type { WorkflowContext, NormalizedStepDefinition } from "./types.js";
import { interpolate } from "./utils.js";
import { randomUUID } from "node:crypto";

export const defaultWorkspace = "/workspace";
export const defaultImage = "dhi.io/alpine-base:3.23-alpine3.23-dev";

// Map to store tmpfs volume names per workflow ID for daemon concurrency safety
const tmpfsVolumeCache = new Map<string, string>();

export function resetTmpfsState(workflowId: string) {
  tmpfsVolumeCache.delete(workflowId);
}

export function ensureTmpfsVolume(context: WorkflowContext): string {
  const workflowId = context.inputs?.workflowId as string;
  
  if (tmpfsVolumeCache.has(workflowId)) {
    return tmpfsVolumeCache.get(workflowId)!;
  }
  
  const id = workflowId || randomUUID().slice(0, 8);
  const name = `on_tmpfs_env_${id}`;
  try {
    // Create a tmpfs (in-memory) volume
    execSync(`docker volume create --driver local --opt type=tmpfs --opt o=size=100M ${name}`, { stdio: "ignore" });
  } catch (e) {
    // Ignore if exists already
  }
  tmpfsVolumeCache.set(workflowId, name);
  return name;
}

export function getTmpfsVolumeName(context: WorkflowContext): string | null {
  const workflowId = context.inputs?.workflowId as string;
  return tmpfsVolumeCache.get(workflowId) ?? null;
}

export function prepareDockerStep(
  step: NormalizedStepDefinition,
  context: WorkflowContext,
) {
  const defaults = context.workflow.defaults || {};

  step.image ||= defaults.image || defaultImage;
  step.volumes ||= defaults.volumes || {};
  step.args ||= defaults.args || [];

  if (step.tmpfs) {
    let volumeName: string;
    const mountPath = "/tmp/on_env"; // Path inside container
    
    if (typeof step.tmpfs === "string") {
      volumeName = step.tmpfs;
    } else {
      volumeName = ensureTmpfsVolume(context);
    }

    step.volumes[volumeName] = mountPath;
    
    // Use 'ENV' as requested
    step.args.push({ "-e": `ENV=${mountPath}` });
  }

  return step;
}

export function prepareDockerArgs(
  args: Record<string, string>[],
  context: WorkflowContext,
): string[] {
  return (args || []).flatMap((arg) =>
    Object.entries(arg).flatMap(([key, value]) => [
      key.startsWith("-") ? key : `--${key}`, 
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

export function prepareEnvArgs(
  context: WorkflowContext,
): string[] {
  // Pass all context.env variables as docker env args (for tmpfs-passed vars)
  const envKeys = Object.keys(context.env || {});
  return envKeys.flatMap((key) => ["-e", `${key}=${interpolate(String(context.env[key]), context)}`]);
}

export function prepareShell(
  step: NormalizedStepDefinition,
  context: WorkflowContext,
) {
  const prepared = prepareDockerStep(step, context);
  const { args, image, volumes } = prepared;
  const mappedVolumes = prepareDockerVolumes(volumes, context);
  const mappedArgs = prepareDockerArgs(args, context);
  const envArgs = prepareEnvArgs(context);
  const workingDir = volumes["."];
  
  const dockerArgs = [
    "run",
    "-i",
    "--rm",
    ...mappedVolumes,
    ...mappedArgs,
    ...envArgs,
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
