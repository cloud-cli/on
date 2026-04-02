import { existsSync } from "node:fs";
import { mkdtemp, rm, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path/posix";
import { dockerRunner } from "@cloud-cli/on-runner-docker";
import { shellRunner } from "@cloud-cli/on-runner-shell";
import { loadSecrets } from "./secrets.js";
import type {
  StepDefinition,
  WorkflowContext,
  WorkflowEvent,
  OnConfig,
  WorkflowDefinition,
  StepOutput,
  EventOutput,
  NormalizedStepDefinition,
  WorkflowRunner,
} from "./types.js";
import { interpolate, withMappings, asObject, toStringProxy } from "./utils.js";
import { randomUUID } from "node:crypto";
import { createReport } from "./reports.js";
const runners: Record<
  WorkflowContext["runner"],
  WorkflowRunner<NormalizedStepDefinition, WorkflowContext, StepOutput>
> = {
  docker: dockerRunner,
  shell: shellRunner,
};

function prepareEnv(context: WorkflowContext) {
  const { workflow, secrets } = context;
  const env = {
    ...process.env,
    ...Object.fromEntries(
      Object.entries(secrets).map(([key, value]) => [key, String(value)]),
    ),
    PWD: context.workingDir,
  } as NodeJS.ProcessEnv;

  if (workflow.env) {
    if (typeof workflow.env !== "object") {
      throw new Error("Workflow env field must be an object.");
    }

    for (const [key, template] of Object.entries(workflow.env)) {
      env[key] = interpolate(template as string, context);
    }
  }

  Object.assign(context.env, env);
}

function validateEvent(eventPayload: WorkflowEvent, config: OnConfig) {
  const { event, source } = eventPayload;
  const eventKeys = Object.keys(event);
  const acceptableEvents = Object.keys(config.on);
  const key = acceptableEvents.find((key) => event[key]);
  const workflow: WorkflowDefinition | null = key ? config.on[key] : null;

  if (!workflow) {
    console.log(
      `No workflow defined for event keys: ${eventKeys.join(", ")}, only accepting ${acceptableEvents.join(", ")}.`,
    );
    return null;
  }

  if (!workflow.steps?.length) {
    console.warn(
      `Workflow for event ${event.source}:${event.event} has no steps defined, skipping.`,
    );
    return null;
  }

  const payload = event[key as string];

  return {
    source,
    workflow: workflow as WorkflowDefinition,
    event: payload as Record<string, unknown>,
  };
}

async function runStep(
  step: NormalizedStepDefinition,
  context: WorkflowContext,
): Promise<StepOutput> {
  const runner = runners[context.runner];
  return runner.run(step, context);
}

function normalizeSteps(
  steps: Array<StepDefinition | string>,
  context: WorkflowContext,
): NormalizedStepDefinition[] {
  return steps.map((step) => {
    if (typeof step === "string") {
      step = { run: step };
    }

    if (typeof step.run !== "string") {
      throw new Error("Each workflow step must have a 'run' command string.");
    }

    return step as NormalizedStepDefinition;
  });
}

export async function processEvent(
  incomingEvent: WorkflowEvent,
  config: OnConfig,
  parentId?: string,
): Promise<EventOutput> {
  const id = randomUUID();
  const validated = validateEvent(incomingEvent, config);

  if (!validated) {
    return { id, parentId, children: [], context: null };
  }

  const { workflow, event } = validated;

  const inputs = workflow.mappings
    ? withMappings(event, workflow.mappings)
    : event;

  const secrets = await loadSecrets(workflow.secrets);
  const workingDir = await mkdtemp(join(tmpdir(), "workflow"));
  const context = toStringProxy<WorkflowContext>({
    inputs,
    secrets,
    workflow,
    env: {},
    outputs: [],
    workingDir,
    runner: workflow.runner || "docker",
  });

  if (workflow.if) {
    // evaluate conditions as JavaScript expressions for truthy values, as an OR list - if any condition is truthy, the workflow runs
    const conditions = workflow.if.map((c) => interpolate(c, context));
    const shouldRun = conditions.some((c) => Function("return " + c)());

    if (!shouldRun) {
      console.log(
        `Workflow for event ${event.source}:${event.event} skipped due to no matching conditions.`,
      );
      return { id, parentId, children: [], context: null };
    }
  }

  const children = [];

  try {
    prepareEnv(context);
    const steps = normalizeSteps(workflow.steps || [], context);

    for (const step of steps) {
      const output = await runStep(step, context);

      if (output.code !== 0) {
        throw new Error(
          `Step failed with code ${output.code}.\nstdout: ${output.stdout}\nstderr: ${output.stderr}`,
        );
      }

      context.outputs.push(output);
    }

    for (const dispatchPath of workflow.triggers ?? []) {
      const next = await processEventFromFile(dispatchPath, config, parentId);
      if (next) {
        children.push(next.id);
      }
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error(`Error processing event: ${message}`);
    console.debug(JSON.stringify(event));
  } finally {
    await rm(context.workingDir, { recursive: true, force: true });
  }

  await createReport({ id, parentId, children }, context);
  // TODO save artifacts and context to a folder along with the report location and include links in the report

  return { id, parentId, children, context };
}

export async function processEventFromFile(
  dispatchPath: string,
  config: OnConfig,
  parentId?: string,
) {
  if (!existsSync(dispatchPath)) {
    console.warn(`Trigger file does not exist: ${dispatchPath}`);
    return;
  }

  const raw = await readFile(dispatchPath, "utf8");
  const dispatchedEvent = {
    event: asObject(JSON.parse(raw)),
    source: "file",
  } as WorkflowEvent;
  return await processEvent(dispatchedEvent, config, parentId);
}
