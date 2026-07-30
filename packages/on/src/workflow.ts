import { randomUUID } from 'node:crypto';
import { existsSync } from 'node:fs';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createReport } from './reports.js';
import * as docker from './runners/docker.js';
import * as shell from './runners/shell.js';
import { loadSecrets } from './secrets.js';
import { DEBUG } from './env.js';
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

  // TODO copy object to avoid mutations from workflow runs
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

export async function processEvent(
  event: WorkflowEvent,
  config: OnConfig,
  parentId?: string,
): Promise<EventOutput | null> {
  const workflowId = event.id || randomUUID();
  const workflow = findWorkflowForEvent(event, config);
  let runError;

  if (!workflow) {
    return null;
  }

  const children: string[] = [];
  let context: WorkflowContext | null = null;

  try {
    const inputs = withMappings(event, workflow.mappings);
    const secrets = await loadSecrets(workflow.secrets);

    context = toStringProxy<WorkflowContext>({
      runner: workflow.runner || 'docker',
      source: event.source,
      workflowId: workflowId,
      inputs,
      secrets,
      workflow,
      env: {},
      outputs: [],
      steps: [],
      workingDir: '',
    });

    if (workflow.if) {
      const conditions = workflow.if.map((c) => interpolate(c, context));
      const shouldRun = conditions.some((c) => Function('return ' + c)());

      if (!shouldRun) {
        console.log(`Workflow for event ${event.source} skipped due to no matching conditions.`);
        return null;
      }
    }

    prepareContextEnv(context);
    context.steps = normalizeSteps(workflow.steps || [], context);
    runError = await runWorkflow(context);

    if (runError) {
      throw runError;
    }

    // TODO tmpfs with JSON outputs for next steps
    // for (const dispatchPath of workflow.triggers ?? []) {
    //   const next = await processEventFromFile(dispatchPath, config, parentId);
    //   if (next) {
    //     children.push(next.id);
    //   }
    // }
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    console.error(`Error processing event: ${message}`, JSON.stringify(event));
  } finally {
    if (context) {
      await rm(context.workingDir, { recursive: true, force: true });
    }

    if (DEBUG) {
      console.log(
        'WORKFLOW ' + workflowId,
        context?.outputs.map((o) => `<${o.code}> ${o.cmd} ${o.stdout} ${o.stderr}`).join('\n') || runError || '<none>',
      );
    }
  }

  await createReport({ id: workflowId, parentId, children }, context, runError);

  return { id: workflowId, parentId, children, context, error: runError };
}

export async function reRunWorkflow(context: WorkflowContext): Promise<EventOutput> {
  context.workflowId = randomUUID();
  const runError = await runWorkflow(context);
  const report = { id: context.workflowId, parentId: undefined, children: [] };
  await createReport(report, context, runError);
  return { ...report, context, error: runError };
}

async function runWorkflow(context: WorkflowContext) {
  const runner: Runner | undefined = runnerMap.get(context.runner);
  if (!runner) {
    throw new Error('Invalid runner: ' + context.runner);
  }

  context.workingDir = await mkdtemp(join(tmpdir(), 'workflow'));

  let error;
  if (runner.setup) {
    await runner.setup(context.workflow, context.inputs);
  }

  for (const step of context.steps) {
    const output = await runner.run(context.workflow, context.inputs, step, context);

    if (output.code !== 0 && !step.continueOnError) {
      error = new Error(`Step failed with code ${output.code}.\nstdout: ${output.stdout}\nstderr: ${output.stderr}`);
      break;
    }

    context.outputs.push(output);
  }

  if (runner.teardown) {
    await runner.teardown(context.workflow, context.inputs);
  }

  return error;
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
