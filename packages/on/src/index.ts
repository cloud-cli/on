#!/usr/bin/env node

import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { parseArgs } from "node:util";
import { spawn } from "node:child_process";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { parse as parseYaml } from "yaml";

type CliOptions = {
  port: number;
  host: string;
  configPath?: string;
};

type WorkflowDefinition = {
  secrets?: string[];
  mappings?: Record<string, string>;
  env?: Record<string, string>;
  defaults?: {
    image?: string;
    volumes?: Record<string, string>;
    args?: Record<string, string | number | boolean>;
  };
  steps?: string[];
  dispatch?: string[];
};

type OnConfig = {
  on?: Record<string, Record<string, WorkflowDefinition>>;
};

type WorkflowEvent = {
  source: string;
  event: string;
  [key: string]: unknown;
};

const HELP_TEXT = `on - daemonized webhook runner

Usage:
  on --port <port> [--host <host>] [--config <path>]

Options:
  --port, -p    HTTP port for incoming webhooks (required)
  --host, -H    Host binding for the HTTP server (default: 127.0.0.1)
  --config, -c  Path to a YAML/JSON config file
  --help, -h    Show this help message
`;

async function readBody(request: IncomingMessage): Promise<string> {
  const chunks: Buffer[] = [];

  for await (const chunk of request) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }

  return Buffer.concat(chunks).toString("utf8");
}

function sendJson(response: ServerResponse, statusCode: number, body: unknown): void {
  response.statusCode = statusCode;
  response.setHeader("content-type", "application/json");
  response.end(JSON.stringify(body));
}

function toConfigPath(configPath: string): string {
  return path.isAbsolute(configPath) ? configPath : path.resolve(process.cwd(), configPath);
}

async function loadConfig(configPath?: string): Promise<OnConfig> {
  if (!configPath) {
    return {};
  }

  const resolvedPath = toConfigPath(configPath);
  const raw = await readFile(resolvedPath, "utf8");

  if (resolvedPath.endsWith(".yaml") || resolvedPath.endsWith(".yml")) {
    return (parseYaml(raw) ?? {}) as OnConfig;
  }

  return JSON.parse(raw) as OnConfig;
}

function normalizePort(portValue: string): number {
  const port = Number.parseInt(portValue, 10);

  if (!Number.isInteger(port) || port < 0 || port > 65535) {
    throw new Error(`Invalid --port value '${portValue}'. Expected an integer from 0 to 65535.`);
  }

  return port;
}

function asObject(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("Incoming webhook payload must be a JSON object.");
  }

  return value as Record<string, unknown>;
}

function resolvePath(target: unknown, pathExpression: string): unknown {
  const normalized = pathExpression.trim().replace(/^\$\{/, "").replace(/}$/, "");
  const pathParts = normalized.split(".").filter(Boolean);

  let cursor: unknown = target;
  for (const segment of pathParts) {
    if (typeof cursor !== "object" || cursor === null || !(segment in cursor)) {
      return undefined;
    }
    cursor = (cursor as Record<string, unknown>)[segment];
  }

  return cursor;
}

function interpolate(template: string, context: Record<string, unknown>): string {
  return template.replace(/\$\{([^}]+)}/g, (_all, expression: string) => {
    const value = resolvePath(context, expression);
    if (value === undefined || value === null) {
      return "";
    }
    return String(value);
  });
}

function parseSecretsFile(contents: string): Record<string, string> {
  return contents
    .split(/\r?\n/u)
    .map((line) => line.trim())
    .filter((line) => line.length > 0 && !line.startsWith("#"))
    .reduce<Record<string, string>>((acc, line) => {
      const equalsIndex = line.indexOf("=");
      if (equalsIndex <= 0) {
        return acc;
      }

      const key = line.slice(0, equalsIndex).trim();
      const value = line.slice(equalsIndex + 1).trim();
      acc[key] = value;
      return acc;
    }, {});
}

async function loadSecrets(secretPaths: string[] | undefined): Promise<Record<string, string>> {
  const resolved: Record<string, string> = {};

  for (const [key, value] of Object.entries(process.env)) {
    if (typeof value === "string") {
      resolved[key] = value;
    }
  }

  for (const secretPath of secretPaths ?? []) {
    const raw = await readFile(secretPath, "utf8");

    if (secretPath.endsWith(".json")) {
      const parsed = asObject(JSON.parse(raw));
      for (const [key, value] of Object.entries(parsed)) {
        if (value !== undefined && value !== null) {
          resolved[key] = String(value);
        }
      }
      continue;
    }

    Object.assign(resolved, parseSecretsFile(raw));
  }

  return resolved;
}

function withMappings(inputs: Record<string, unknown>, mappings: Record<string, string> | undefined): Record<string, unknown> {
  if (!mappings) {
    return { ...inputs };
  }

  const nextInputs = { ...inputs };
  for (const [field, pathExpression] of Object.entries(mappings)) {
    const normalized = pathExpression.startsWith("${") ? pathExpression : `\${${pathExpression}}`;
    nextInputs[field] = resolvePath({ inputs: nextInputs }, normalized);
  }

  return nextInputs;
}

async function runStep(step: string, env: NodeJS.ProcessEnv): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const child = spawn(step, {
      env,
      shell: true,
      stdio: "inherit"
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

async function processEvent(event: WorkflowEvent, config: OnConfig): Promise<void> {
  if (typeof event.source !== "string" || typeof event.event !== "string") {
    throw new Error("Incoming payload must include string fields 'source' and 'event'.");
  }

  const workflow = config.on?.[event.source]?.[event.event];
  if (!workflow) {
    throw new Error(`No workflow configured for source '${event.source}' and event '${event.event}'.`);
  }

  const inputs = withMappings({ ...event }, workflow.mappings);
  const secrets = await loadSecrets(workflow.secrets);

  const environment: NodeJS.ProcessEnv = {
    ...process.env,
    ...Object.fromEntries(Object.entries(secrets).map(([key, value]) => [key, String(value)]))
  };

  const context = {
    inputs,
    secrets
  };

  for (const [key, template] of Object.entries(workflow.env ?? {})) {
    environment[key] = interpolate(template, context);
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
      help: { type: "boolean", short: "h", default: false }
    },
    allowPositionals: false
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
    configPath: values.config
  };
}

export async function startDaemon(options: CliOptions): Promise<ReturnType<typeof createServer>> {
  const config = await loadConfig(options.configPath);

  const server = createServer(async (request, response) => {
    if (request.method !== "POST") {
      sendJson(response, 405, { error: "Only POST webhooks are supported." });
      return;
    }

    try {
      const rawBody = await readBody(request);
      const event = asObject(rawBody.length > 0 ? JSON.parse(rawBody) : {}) as WorkflowEvent;
      await processEvent(event, config);

      sendJson(response, 202, {
        status: "accepted",
        source: event.source,
        event: event.event
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
    console.log(`on daemon listening on http://${address.address}:${address.port}`);
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

if (import.meta.url === `file://${process.argv[1]}`) {
  void main();
}
