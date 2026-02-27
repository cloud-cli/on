#!/usr/bin/env node

import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { parseArgs } from "node:util";
import { spawn } from "node:child_process";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { parse as parseYaml } from "yaml";

type SpawnRequest = {
  command: string;
  args?: string[];
  cwd?: string;
  env?: Record<string, string>;
  detached?: boolean;
};

type OnConfig = {
  defaults?: Omit<SpawnRequest, "command">;
  routes?: Record<string, SpawnRequest>;
};

type CliOptions = {
  port: number;
  host: string;
  configPath?: string;
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

function mergeSpawnRequest(
  defaults: OnConfig["defaults"],
  route: SpawnRequest | undefined,
  body: Partial<SpawnRequest>
): Partial<SpawnRequest> {
  return {
    ...(defaults ?? {}),
    ...(route ?? {}),
    ...(body ?? {})
  };
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
      const body = rawBody.length > 0 ? (JSON.parse(rawBody) as Partial<SpawnRequest>) : {};
      const route = config.routes?.[request.url ?? "/"];
      const spawnRequest = mergeSpawnRequest(config.defaults, route, body);

      if (!spawnRequest.command || typeof spawnRequest.command !== "string") {
        sendJson(response, 400, {
          error: "Missing spawn command. Provide {\"command\":\"...\"} in the webhook body or configure a route command."
        });
        return;
      }

      if (spawnRequest.args && !Array.isArray(spawnRequest.args)) {
        sendJson(response, 400, { error: "'args' must be an array of strings when provided." });
        return;
      }

      const child = spawn(spawnRequest.command, spawnRequest.args ?? [], {
        cwd: spawnRequest.cwd,
        env: {
          ...process.env,
          ...(spawnRequest.env ?? {})
        },
        detached: spawnRequest.detached ?? true,
        stdio: "ignore"
      });

      child.unref();

      sendJson(response, 202, {
        status: "accepted",
        pid: child.pid,
        command: spawnRequest.command,
        args: spawnRequest.args ?? []
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
