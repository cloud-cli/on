import { execSync, spawn } from 'node:child_process';
import { existsSync, readdirSync, readFileSync, unlinkSync } from 'node:fs';
import { join } from 'node:path';
import type {
  NormalizedStepDefinition,
  StepOutput,
  WorkflowContext,
  WorkflowDefinition,
  WorkflowEvent,
} from '../types.js';
import { interpolate, withMappings } from '../utils.js';
import { DEBUG }  from '../env.js';

export const defaultWorkspace = '/workspace';
export const defaultImage = 'dhi.io/alpine-base:3.23-alpine3.23-dev';
export const SHELL = process.env.DOCKER_SHELL || 'sh';

// Map to store tmpfs volume names per workflow ID for daemon concurrency safety
const tmpfsVolumeCache = new Map<string, string>();

// Map to track which env vars came from tmpfs (per workflow) for container injection
export const tmpfsEnvVarsCache = new Map<string, Set<string>>();

export function resetTmpfsState(workflowId: string) {
  tmpfsVolumeCache.delete(workflowId);
  tmpfsEnvVarsCache.delete(workflowId);
}

export function ensureTmpfsVolume(context: WorkflowContext): string {
  const workflowId = context.inputs.workflowId as string;

  if (tmpfsVolumeCache.has(workflowId)) {
    return tmpfsVolumeCache.get(workflowId)!;
  }

  const name = `on_tmpfs_env_${workflowId}`;

  try {
    // Create a tmpfs (in-memory) volume
    execSync(`docker volume create --driver local --opt type=tmpfs --opt o=size=100M ${name}`, { stdio: 'ignore' });
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

export function prepareDockerStep(step: NormalizedStepDefinition, context: WorkflowContext) {
  const defaults = context.workflow.defaults || {};

  step.image ||= defaults.image || defaultImage;
  step.volumes ||= defaults.volumes || {};
  step.args ||= defaults.args || [];
  step.env ||= {};

  const tmpfs = ensureTmpfsVolume(context);
  const mountPath = '/tmp/on_env';

  step.volumes[tmpfs] = mountPath;
  step.env.ENV = mountPath;

  return step;
}

export function prepareDockerArgs(args: Record<string, string>[], context: WorkflowContext): string[] {
  return (args || []).flatMap((arg) =>
    Object.entries(arg).flatMap(([key, value]) => [
      key.startsWith('-') ? key : `--${key}`,
      interpolate(String(value), context),
    ]),
  );
}

export function prepareDockerVolumes(volumes: Record<string, string>, context: WorkflowContext): string[] {
  volumes['.'] ||= defaultWorkspace;
  return Object.entries(volumes).flatMap(([hostPath, containerPath]) => [
    '-v',
    `${hostPath === '.' ? context.workingDir : hostPath}:${containerPath}`,
  ]);
}

export function prepareEnv(context: WorkflowContext, step: NormalizedStepDefinition) {
  const env = Object.assign({}, context.env, step.env);
  const envKeys = Object.keys(env);

  for (const [key, value] of Object.entries(env)) {
    env[key] = interpolate(String(value), context);
  }

  return {
    env,
    envArgs: envKeys.flatMap((key) => ['-e', key]),
  };
}

export function prepareShell(step: NormalizedStepDefinition, context: WorkflowContext) {
  const prepared = prepareDockerStep(step, context);
  const { args, image, volumes } = prepared;
  const mappedVolumes = prepareDockerVolumes(volumes, context);
  const mappedArgs = prepareDockerArgs(args, context);
  const { env, envArgs } = prepareEnv(context, step);
  const workingDir = volumes['.'];

  const dockerArgs = [
    'run',
    '-i',
    '--rm',
    ...mappedVolumes,
    ...mappedArgs,
    ...envArgs,
    '-w',
    workingDir,
    '--entrypoint',
    'sh',
    image,
  ] as string[];

  return spawn('docker', dockerArgs, { env: context.env });
}

function getHostMountPoint(volumeName: string): string {
  try {
    const output = execSync(`docker volume inspect -f '{{.Mountpoint}}' ${volumeName}`).toString().trim();
    return output;
  } catch (e) {
    console.warn(`Failed to inspect docker volume:`, e);
    return '';
  }
}

function loadAndCleanTmpfs(context: WorkflowContext, volName: string): Record<string, string> {
  const loaded: Record<string, string> = {};
  const volPath = getHostMountPoint(volName);

  if (!volPath || !existsSync(volPath)) return loaded;

  try {
    const files = readdirSync(volPath).filter((f) => f.endsWith('.json'));

    for (const file of files) {
      const content = readFileSync(join(volPath, file), 'utf-8');
      try {
        const data = JSON.parse(content);
        // Assuming the JSON object contains key-value pairs to expand env
        Object.assign(loaded, withMappings(data, context.workflow.mappings));
      } catch {}

      // Remove files as requested
      unlinkSync(join(volPath, file));
    }
  } catch (e) {
    console.warn(`Failed to process tmpfs:`, e);
  }

  return loaded;
}

export async function setup(wf: WorkflowDefinition, event: WorkflowEvent) {
  // TODO
}

export async function teardown(wf: WorkflowDefinition, event: WorkflowEvent) {
  // TODO
}

export async function run(
  _wf: WorkflowDefinition,
  _event: WorkflowEvent,
  step: NormalizedStepDefinition,
  context: WorkflowContext,
): Promise<StepOutput> {
  const stdout: Buffer[] = [];
  const stderr: Buffer[] = [];
  const cmd = interpolate(step.run, context);
  const shell = prepareShell(step, context);

  shell.stdout?.on('data', (data) => stdout.push(data));
  shell.stderr?.on('data', (data) => stderr.push(data));

  return new Promise<StepOutput>((resolve, reject) => {
    shell.once('error', reject);
    shell.once('exit', (code) => {
      const stepOutput = {
        code: code ?? 0,
        cmd: cmd,
        stdout: Buffer.concat(stdout).toString('utf-8'),
        stderr: Buffer.concat(stderr).toString('utf-8'),
      };

      resolve(stepOutput);
    });

    if (DEBUG) {
      console.log('DOCKER', cmd);
    }

    shell.stdin?.write(cmd);
    shell.stdin?.write('\nexit $?;\n');
    shell.stdin?.end();
  });
}
