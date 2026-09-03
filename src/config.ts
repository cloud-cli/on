import { existsSync, statSync } from 'node:fs';
import { resolve } from 'node:path';
import { setUrl } from './db-client.js';
import { RunnerConfig, UserRunnerConfig } from './types.js';
import { parseArgs } from 'node:util';

export async function loadConfig(values): Promise<RunnerConfig | null> {
  const configFromCli: UserRunnerConfig = {
    port: Number(values.port),
    database: values.database,
    workflows: values.workflows,
    workers: values.workers ? Number(values.workers) : undefined,
  };

  let configFromFile = {};
  const configPath = resolve(values.config);

  if (existsSync(configPath) && statSync(configPath).isFile()) {
    configFromFile = (await import(configPath)).default || {};
  }

  const config = resolveConfig(configFromFile, configFromCli);

  if (!existsSync(config.workflows)) {
    console.warn(`⚠️ Warning: Workflows directory '${config.workflows}' not found.`);
    return null;
  }

  setUrl(config.database);

  return config;
}

export function resolveConfig(configFromFile: UserRunnerConfig, configFromCli: UserRunnerConfig): RunnerConfig {
  const _ = process.env;
  return {
    port: Number(configFromFile.port || configFromCli.port || _.PORT || 11235),
    adminToken: configFromFile.adminToken ?? _.RUNNER_ADMIN_SECRET ?? '',
    database: configFromFile.database ?? configFromCli.database ?? _.RUNNER_DATABASE_URL ?? '',
    workflows: configFromFile.workflows ?? configFromCli.workflows ?? _.RUNNER_WORKFLOWS ?? 'on/',
    workers: Number(configFromFile.workers ?? configFromCli.workers ?? _.RUNNER_WORKERS ?? 5),
    storagePath: configFromFile.storagePath ?? _.RUNNER_TMP ?? '/tmp/workspaces',
    env: configFromFile.env ?? {},
    reporters: configFromFile.reporters ?? [],
  };
}

export function printHelp() {
  console.log(`
🏃 Runner CLI 🏃

Usage:
  npx -y @cloud-cli/on <command> [options]
  pnpm dlx -y @cloud-cli/on <command> [options]

Commands:
  start           Runs both Webhook Ingress Server and Workers (Default)
  start-server    Runs Webhook Ingress Server only (API Gateway mode)
  start-workers   Runs Worker Polling loops only (Scalable Worker mode)
  validate        Parses and validates workflow YAML files without running

Options:
  -c, --config     Path to runner.config.mjs (default: ./runner.config.mjs, env: RUNNER_CONFIG_PATH)
  -d, --database   SQLite Database URL (env: RUNNER_DATABASE_URL)
  -w, --workflows  Path to where your workflows are defined (default: on/, env: RUNNER_WORKFLOWS_PATH)
  -p, --port       Port for Webhook Ingress Server (default: 11235, env: PORT)
  -k, --workers    Number of worker thread loops to spawn (default: 5, env: RUNNER_WORKERS)
  -h, --help       Show this help message
  `);
}

export async function loadFromArgs(): Promise<{ config: RunnerConfig; command: string }> {
  const { values, positionals } = parseArgs({
    allowPositionals: true,
    options: {
      config: { type: 'string', short: 'c', default: process.env.RUNNER_CONFIG_FILE || './runner.config.mjs' },
      database: { type: 'string', short: 'd' },
      workflows: { type: 'string', short: 'w' },
      port: { type: 'string', short: 'p' },
      workers: { type: 'string', short: 'k' },
      help: { type: 'boolean', short: 'h' },
    },
  });

  if (values.help) {
    printHelp();
    process.exit(0);
  }

  const config = await loadConfig(values);

  return {
    config,
    command: positionals[0] || 'start',
  };
}
