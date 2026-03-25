#!/usr/bin/env node

import { createServer } from "node:http";
import { parseArgs } from "node:util";
import { spawn } from "node:child_process";
import { readFile } from "node:fs/promises";

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
  step.run = interpolate(step.run, context);

  step.volumes["."] ||= "/workspace";

  return step as NormalizedStepDefinition;
}

function prepareArgs(
  args: Record<string, string>[],
  context: WorkflowContext,
): string[] {
  return args.flatMap((arg) =>
    Object.entries(arg).flatMap(([key, value]) => [
      `--${key}`,
      interpolate(String(value), context),
    ]),
  );
}

function prepareVolumes(volumes: Record<string, string>) {
  return Object.entries(volumes).flatMap(([hostPath, containerPath]) => [
    "-v",
    `${hostPath === "." ? process.cwd() : hostPath}:${containerPath}`,
  ]);
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
  const workdir = volumes["."];
  const mappedVolumes = prepareVolumes(volumes);
  const mappedArgs = prepareArgs(args, context);

  await new Promise<void>((resolve, reject) => {
    const child = spawn(
      "docker",
      [
        "run",
        "-it",
        ...mappedVolumes,
        ...mappedArgs,
        "-w",
        workdir,
        "--entrypoint",
        "sh",
        image,
      ] as string[],
      {
        env: context.env,
        shell: true,
        stdio: "inherit",
      },
    );

    child.once("error", reject);
    child.once("exit", (code) => {
      if (code === 0) {
        resolve();
        return;
      }
      reject(new Error(`Step failed with exit code ${code}: ${step}`));
    });

    child.on("spawn", () => {
      child.stdin?.write(prepared.run);
      child.stdin?.end();
    });
  });
}

function validateEvent(
  event: WorkflowEvent,
  config: OnConfig,
): WorkflowDefinition | false {
  if (typeof event.source !== "string" || typeof event.event !== "string") {
    console.log(
      "Incoming payload must include string fields 'source' and 'event'.",
    );
    return false;
  }

  const workflow = config.on?.[event.source]?.[event.event];

  if (!workflow) {
    console.log(
      `No workflow found for event ${event.source}:${event.event}, skipping.`,
    );
    return false;
  }

  if (!workflow.steps || workflow.steps.length === 0) {
    console.warn(
      `Workflow for event ${event.source}:${event.event} has no steps defined, skipping.`,
    );
    return false;
  }

  return workflow as WorkflowDefinition;
}

async function processEvent(
  event: WorkflowEvent,
  config: OnConfig,
): Promise<void> {
  const workflow = validateEvent(event, config);

  if (!workflow) {
    return;
  }

  const inputs = withMappings({ ...event }, workflow.mappings);
  const secrets = await loadSecrets(workflow.secrets);
  const context: WorkflowContext = { inputs, secrets, workflow, env: {} };

  prepareEnv(context);

  for (const step of workflow.steps ?? []) {
    await runStep(step, context);
  }

  for (const dispatchPath of workflow.triggers ?? []) {
    await processEventFromFile(dispatchPath, config);
  }
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

function prepareEnv(context: WorkflowContext) {
  const { workflow, secrets } = context;
  const env = {
    ...process.env,
    ...Object.fromEntries(
      Object.entries(secrets).map(([key, value]) => [key, String(value)]),
    ),
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
      await processEvent(event, config);

      sendJson(response, 202, {
        status: "accepted",
        source: event.source,
        event: event.event,
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
