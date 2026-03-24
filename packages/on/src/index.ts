#!/usr/bin/env node

import { createServer } from "node:http";
import { parseArgs } from "node:util";
import { spawn } from "node:child_process";
import { readFile } from "node:fs/promises";

import type { CliOptions, OnConfig, WorkflowEvent } from "./types.js";
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

const HELP_TEXT = `on - daemonized webhook runner

Usage:
  on --port <port> [--host <host>] [--config <path>]

Options:
  --port, -p    HTTP port for incoming webhooks (required)
  --host, -H    Host binding for the HTTP server (default: 127.0.0.1)
  --config, -c  Path to a YAML/JSON config file
  --help, -h    Show this help message
`;

async function runStep(step: string, env: NodeJS.ProcessEnv): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const child = spawn(step, {
      env,
      shell: true,
      stdio: "inherit",
    });

    child.once("error", reject);
    child.once("exit", (code) => {
      if (code === 0) {
        resolve();
        return;
      }
      reject(new Error(`Step failed with exit code ${code}: ${step}`));
    });
  });
}

async function processEvent(
  event: WorkflowEvent,
  config: OnConfig,
): Promise<void> {
  if (typeof event.source !== "string" || typeof event.event !== "string") {
    throw new Error(
      "Incoming payload must include string fields 'source' and 'event'.",
    );
  }

  const workflow = config.on?.[event.source]?.[event.event];
  if (!workflow) {
    throw new Error(
      `No workflow configured for source '${event.source}' and event '${event.event}'.`,
    );
  }

  const inputs = withMappings({ ...event }, workflow.mappings);
  const secrets = await loadSecrets(workflow.secrets);

  const environment: NodeJS.ProcessEnv = {
    ...process.env,
    ...Object.fromEntries(
      Object.entries(secrets).map(([key, value]) => [key, String(value)]),
    ),
  };

  const context = {
    inputs,
    secrets,
  };

  for (const [key, template] of Object.entries(workflow.env ?? {})) {
    environment[key] = interpolate(template as string, context);
  }

  if (workflow.defaults?.image) {
    environment.ON_DEFAULT_IMAGE = workflow.defaults.image;
  }

  if (workflow.defaults?.volumes) {
    environment.ON_DEFAULT_VOLUMES = JSON.stringify(workflow.defaults.volumes);
  }

  if (workflow.defaults?.args) {
    environment.ON_DEFAULT_ARGS = JSON.stringify(workflow.defaults.args);
  }

  for (const step of workflow.steps ?? []) {
    await runStep(step, environment);
  }

  for (const dispatchPath of workflow.dispatch ?? []) {
    const raw = await readFile(dispatchPath, "utf8");
    const dispatchedEvent = asObject(JSON.parse(raw)) as WorkflowEvent;
    await processEvent(dispatchedEvent, config);
  }
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
