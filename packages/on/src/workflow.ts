import { randomUUID } from 'node:crypto';
import { existsSync } from 'node:fs';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
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
  WorkflowContext,
  WorkflowEvent,
} from './types.js';
import { asObject, interpolate, toStringProxy, withMappings } from './utils.js';

const runnerMap = new Map<string, Runner>();
runnerMap.set('docker', docker);
runnerMap.set('shell', shell);

function prepareContextEnv(context: WorkflowContext) {
  const { workflow, secrets } = context;
  const env = {
    ...process.env,

    // TODO make env vars from secrets more explicit
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
  let error;

  if (!workflow) {
    return { id, parentId, children: [], context: null };
  }

  const children: string[] = [];
  let context: WorkflowContext | null = null;

  try {
    const inputs = withMappings(event, workflow.mappings);
    const secrets = await loadSecrets(workflow.secrets);
    const workingDir = await mkdtemp(join(tmpdir(), 'workflow'));
    context = toStringProxy<WorkflowContext>({
      source: event.source,
      workflowId: id,
      inputs,
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

    prepareContextEnv(context);

    const runner = runnerMap.get(context.runner);

    if (!runner) {
      throw new Error('Invalid runner: ' + context.runner);
    }

    const steps = normalizeSteps(workflow.steps || [], context);

    if (runner.setup) {
      await runner.setup(workflow, event);
    }

    for (const step of steps) {
      const output = await runner.run(workflow, event, step, context);

      if (output.code !== 0 && !step.continueOnError) {
        error = Error(`Step failed with code ${output.code}.\nstdout: ${output.stdout}\nstderr: ${output.stderr}`);
        break;
      }

      context.outputs.push(output);
    }

    if (runner.teardown) {
      await runner.teardown(workflow, event);
    }

    if (error) {
      throw error;
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
    if (context) {
      await rm(context.workingDir, { recursive: true, force: true });
    }
  }

  await createReport({ id, parentId, children }, context, error);

  return { id, parentId, children, context, error };
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
