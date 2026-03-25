#!/usr/bin/env node

import { createServer } from "node:http";
import { parseArgs } from "node:util";
import { spawn } from "node:child_process";
import { mkdtemp, readFile, rm } from "node:fs/promises";

import type {
  CliOptions,
  OnConfig,
  WorkflowEvent,
  WorkflowContext,
  StepDefinition,
  NormalizedStepDefinition,
  WorkflowDefinition,
} from "./types.js";
import {
  asObject,
  interpolate,
  normalizePort,
  readBody,
  sendJson,
  withMappings,
} from "./utils.js";
import { loadConfig } from "./config.js";
import { loadSecrets } from "./secrets.js";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const defaultWorkspace = "/workspace";
const HELP_TEXT = `on - daemonized webhook runner

Usage:
  on --port <port> [--host <host>] [--config <path>]

Options:
  --port, -p    HTTP port for incoming webhooks (required)
  --host, -H    Host binding for the HTTP server (default: 127.0.0.1)
  --config, -c  Path to a YAML/JSON config file
  --help, -h    Show this help message
`;

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

  // console.debug("docker", dockerArgs.join(" "));
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

async function processEvent(
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

export function parseCliOptions(argv: string[]): CliOptions | null {
  const { values } = parseArgs({
    args: argv,
    options: {
      port: { type: "string", short: "p" },
      host: { type: "string", short: "H", default: "127.0.0.1" },
      config: { type: "string", short: "c" },
      help: { type: "boolean", short: "h", default: false },
    },
    allowPositionals: false,
  });

  if (values.help) {
    console.log(HELP_TEXT);
    return null;
  }

  if (!values.port) {
    throw new Error("Missing required option --port.");
  }

  return {
    port: normalizePort(values.port),
    host: values.host,
    configPath: values.config,
  };
}

export async function startDaemon(
  options: CliOptions,
): Promise<ReturnType<typeof createServer>> {
  const config = await loadConfig(options.configPath);

  const server = createServer(async (request, response) => {
    if (request.method !== "POST") {
      sendJson(response, 405, { error: "Only POST webhooks are supported." });
      return;
    }

    try {
      const rawBody = await readBody(request);
      const event = asObject(
        rawBody.length > 0 ? JSON.parse(rawBody) : {},
      ) as WorkflowEvent;

      const outputs = await processEvent(event, config);

      sendJson(response, 202, {
        status: "accepted",
        outputs,
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : "Unknown error";
      sendJson(response, 400, { error: message });
    }
  });

  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(options.port, options.host, () => resolve());
  });

  const address = server.address();
  if (address && typeof address === "object") {
    console.log(
      `on daemon listening on http://${address.address}:${address.port}`,
    );
  }

  return server;
}

export async function main(): Promise<void> {
  try {
    const options = parseCliOptions(process.argv.slice(2));
    if (!options) {
      process.exitCode = 0;
      return;
    }

    await startDaemon(options);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error(`on: ${message}`);
    process.exitCode = 1;
  }
}

main();
