import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdtemp, rm, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path/posix";
import { loadSecrets } from "./secrets.js";
import type {
  StepDefinition,
  WorkflowContext,
  NormalizedStepDefinition,
  WorkflowEvent,
  OnConfig,
  WorkflowDefinition,
} from "./types.js";
import { interpolate, withMappings, asObject } from "./utils.js";

export const defaultWorkspace = "/workspace";

function prepareStep(step: StepDefinition, context: WorkflowContext) {
  if (typeof step.run !== "string") {
    throw new Error("Each workflow step must have a 'run' command string.");
  }
  const defaults = context.workflow.defaults || {};

  step.image ||= defaults.image;
  step.volumes ||= defaults.volumes || {};
  step.args ||= defaults.args;
  step.run = interpolate(step.run, { ...context, step });

  return step as NormalizedStepDefinition;
}

function prepareArgs(
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

function prepareVolumes(
  volumes: Record<string, string>,
  context: WorkflowContext,
): string[] {
  volumes["."] ||= defaultWorkspace;
  return Object.entries(volumes).flatMap(([hostPath, containerPath]) => [
    "-v",
    `${hostPath === "." ? context.workingDir : hostPath}:${containerPath}`,
  ]);
}

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

  context.env = env;
}

async function runStep(
  step: StepDefinition | string,
  context: WorkflowContext,
): Promise<void> {
  if (typeof step === "string") {
    step = { run: step };
  }

  const prepared = prepareStep(step, context);
  const { args, image, volumes } = prepared;
  const mappedVolumes = prepareVolumes(volumes, context);
  const mappedArgs = prepareArgs(args, context);
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

  await new Promise<void>((resolve, reject) => {
    const child = spawn("docker", dockerArgs, { env: context.env });

    child.stdout?.pipe(process.stdout);
    child.stderr?.pipe(process.stderr);

    child.once("error", reject);
    child.once("exit", (code) => {
      if (code === 0) {
        resolve();
        return;
      }
      reject(new Error(`Step failed with exit code ${code}: ${step}`));
    });

    child.stdin?.write(prepared.run);
    child.stdin?.write("\nexit $?;\n");
    child.stdin?.end();
  });
}
function validateEvent(event: WorkflowEvent, config: OnConfig) {
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

  if (!workflow.steps || workflow.steps.length === 0) {
    console.warn(
      `Workflow for event ${event.source}:${event.event} has no steps defined, skipping.`,
    );
    return null;
  }

  const eventPayload = event[key as string];
  return {
    workflow: workflow as WorkflowDefinition,
    event: eventPayload as Record<string, unknown>,
  };
}
export async function processEvent(
  incomingEvent: WorkflowEvent,
  config: OnConfig,
): Promise<Record<string, unknown> | void> {
  const validated = validateEvent(incomingEvent, config);

  if (!validated) {
    return;
  }

  const { workflow, event } = validated;

  const inputs = withMappings(event, workflow.mappings);
  const secrets = await loadSecrets(workflow.secrets);
  const workingDir = await mkdtemp(join(tmpdir(), "workflow"));
  const context: WorkflowContext = {
    inputs,
    secrets,
    workflow,
    env: {},
    outputs: {},
    workingDir,
  };

  prepareEnv(context);

  try {
    for (const step of workflow.steps ?? []) {
      await runStep(step, context);
    }

    for (const dispatchPath of workflow.triggers ?? []) {
      await processEventFromFile(dispatchPath, config);
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error(`Error processing event: ${message}`);
    console.debug(JSON.stringify(event));
  } finally {
    // Cleanup working directory
    await rm(context.workingDir, { recursive: true, force: true });
  }

  return context.outputs;
}

async function processEventFromFile(dispatchPath: string, config: OnConfig) {
  if (!existsSync(dispatchPath)) {
    console.warn(`Trigger file does not exist: ${dispatchPath}`);
    return;
  }

  const raw = await readFile(dispatchPath, "utf8");
  const dispatchedEvent = asObject(JSON.parse(raw)) as WorkflowEvent;
  await processEvent(dispatchedEvent, config);
}
