import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { existsSync } from 'node:fs';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path/posix';
import { ensureTmpfsVolume, prepareShell, resetTmpfsState, setTmpfsEnvVars } from '../docker.js';
import { createReport } from './reports.js';
import * as docker from './runners/docker.js';
import * as shell from './runners/shell.js';
import { loadSecrets } from './secrets.js';
import type {
  EventOutput,
  NormalizedStepDefinition,
  OnConfig,
  Runner,
  StepDefinition,
  StepOutput,
  WorkflowContext,
  WorkflowDefinition,
  WorkflowEvent,
} from './types.js';
import { asObject, interpolate, toStringProxy, withMappings } from './utils.js';

const runnerMap = new Map<string, Runner>();
runnerMap.set('docker', docker);
runnerMap.set('shell', shell);

function prepareEnv(context: WorkflowContext) {
  const { workflow, secrets } = context;
  const env = {
    ...process.env,
    ...Object.fromEntries(Object.entries(secrets).map(([key, value]) => [key, String(value)])),
    PWD: context.workingDir,
  } as NodeJS.ProcessEnv;

  if (workflow.env) {
    if (typeof workflow.env !== 'object') {
      throw new Error('Workflow env field must be an object.');
    }

    for (const [key, template] of Object.entries(workflow.env)) {
      env[key] = interpolate(template as string, context);
    }
  }

  Object.assign(context.env, env);
}

function findWorkflowForEvent(eventPayload: WorkflowEvent, config: OnConfig) {
  const { source, event } = eventPayload;
  const acceptableEvents = Object.keys(config.on);
  const workflow = config.on[source];

  if (!workflow) {
    console.log(`No workflow defined for: ${source}. Only accepting ${acceptableEvents.join(', ')}.`);
    return null;
  }

  if (!workflow.steps?.length) {
    console.warn(`Workflow for event ${event.source}:${event.event} has no steps defined, skipping.`);
    return null;
  }

  return workflow;
}

async function runStep(
  wf: WorkflowDefinition,
  event: WorkflowEvent,
  step: NormalizedStepDefinition,
  context: WorkflowContext,
): Promise<StepOutput> {
  const stdout: Buffer[] = [];
  const stderr: Buffer[] = [];
  const cmd = interpolate(step.run, context);

  const runner = runnerMap.get(context.runner);
  if (!runner) {
    throw new Error('Invalid runner: ' + context.runner);
  }

  return await runner.run(wf, event, step, context);
}

function normalizeSteps(steps: Array<StepDefinition | string>, context: WorkflowContext): NormalizedStepDefinition[] {
  return steps.map((step) => {
    if (typeof step === 'string') {
      step = { run: step };
    }

    if (typeof step.run !== 'string') {
      throw new Error("Each workflow step must have a 'run' command string.");
    }

    return step as NormalizedStepDefinition;
  });
}

export async function processEvent(event: WorkflowEvent, config: OnConfig, parentId?: string): Promise<EventOutput> {
  const id = randomUUID();
  const workflow = findWorkflowForEvent(event, config);
  const payload = event.event;

  if (!workflow) {
    return { id, parentId, children: [], context: null };
  }

  const inputs = workflow.mappings ? withMappings(payload, workflow.mappings) : event;
  const secrets = await loadSecrets(workflow.secrets);
  const workingDir = await mkdtemp(join(tmpdir(), 'workflow'));
  const context = toStringProxy<WorkflowContext>({
    inputs: { ...inputs, workflowId: id },
    secrets,
    workflow,
    env: {},
    outputs: [],
    workingDir,
    runner: workflow.runner || 'docker',
  });

  if (workflow.if) {
    const conditions = workflow.if.map((c) => interpolate(c, context));
    const shouldRun = conditions.some((c) => Function('return ' + c)());

    if (!shouldRun) {
      console.log(`Workflow for event ${event.source}:${event.event} skipped due to no matching conditions.`);
      return { id, parentId, children: [], context: null };
    }
  }

  const children: string[] = [];
  let tmpfs;

  try {
    prepareEnv(context);
    const steps = normalizeSteps(workflow.steps || [], context);

    for (const step of steps) {
      const output = await runStep(workflow, event, step, context);

      if (output.code !== 0) {
        throw new Error(`Step failed with code ${output.code}.\nstdout: ${output.stdout}\nstderr: ${output.stderr}`);
      }

      if (step.tmpfs) {
        const currentVolName = typeof tmpfs === 'string' ? tmpfs : ensureTmpfsVolume(context);
        const newEnv = loadAndCleanTmpfs(context, currentVolName);
        const tmpfsVars = new Set<string>();

        Object.keys(newEnv).forEach((key) => {
          context.env[key] = String(newEnv[key]);
          tmpfsVars.add(key);
        });

        setTmpfsEnvVars(workflowId, tmpfsVars);
      }

      context.outputs.push(output);
    }

    // TODO tmpfs with JSON outputs for next steps
    // for (const dispatchPath of workflow.triggers ?? []) {
    //   const next = await processEventFromFile(dispatchPath, config, parentId);
    //   if (next) {
    //     children.push(next.id);
    //   }
    // }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error(`Error processing event: ${message}`);
    console.debug(JSON.stringify(event));
  } finally {
    await rm(context.workingDir, { recursive: true, force: true });
  }

  await createReport({ id, parentId, children }, context);

  return { id, parentId, children, context };
}

export async function processEventFromFile(dispatchPath: string, config: OnConfig, parentId?: string) {
  if (!existsSync(dispatchPath)) {
    console.warn(`Trigger file does not exist: ${dispatchPath}`);
    return;
  }

  const raw = await readFile(dispatchPath, 'utf8');
  const dispatchedEvent = {
    event: asObject(JSON.parse(raw)),
    source: 'file',
  } as WorkflowEvent;
  return await processEvent(dispatchedEvent, config, parentId);
}
