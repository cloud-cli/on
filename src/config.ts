import { existsSync, statSync } from 'node:fs';
import { resolve } from 'node:path';
import { setUrl } from './db-client.js';
import { RunnerConfig, UserRunnerConfig } from './types.js';
import { parseArgs } from 'node:util';

export async function loadConfig(values): Promise<RunnerConfig | null> {
  const configFromCli: UserRunnerConfig = {
    port: Number(values.port),
    database: values.database,
    workers: values.workers ? Number(values.workers) : undefined,
  };

  let configFromFile = {};
  const configPath = resolve(values.config);

  if (existsSync(configPath) && statSync(configPath).isFile()) {
    configFromFile = (await import(configPath)).default || {};
  }

  const config = resolveConfig(configFromFile, configFromCli);

  setUrl(config.database);

  return config;
}

export function resolveConfig(configFromFile: UserRunnerConfig, configFromCli: UserRunnerConfig): RunnerConfig {
  const _ = process.env;
  const port = Number(configFromFile.port || configFromCli.port || _.PORT || 11235);
  const configuredTags = configFromFile.tags ?? (_.RUNNER_TAGS ? _.RUNNER_TAGS.split(',') : []);
  return {
    port,
    adminToken: configFromFile.adminToken ?? _.RUNNER_ADMIN_SECRET ?? '',
    database: configFromFile.database ?? configFromCli.database ?? _.RUNNER_DATABASE_URL ?? '',
    workers: Number(configFromFile.workers ?? configFromCli.workers ?? _.RUNNER_WORKERS ?? 5),
    serverUrl: configFromFile.serverUrl ?? _.RUNNER_SERVER_URL ?? `http://127.0.0.1:${port}`,
    tags: configuredTags.map((tag) => tag.trim()).filter(Boolean),
    storagePath: configFromFile.storagePath ?? _.RUNNER_TMP ?? '/tmp/workspaces',
    env: configFromFile.env ?? {},
    plugins: configFromFile.plugins ?? [],
  };
}

export function printHelp() {
  console.log(`
🏃 Runner CLI 🏃

Usage:
  npx -y @cloud-cli/on <command> [options]
  pnpm dlx -y @cloud-cli/on <command> [options]

Commands:
    start-server    Runs Webhook Ingress Server only (API Gateway mode)
    start-scheduler Runs cron and solar workflow triggers
    start-workers   Runs event-driven workers (Scalable Worker mode)

Options:
  -c, --config     Path to runner.config.mjs (default: ./runner.config.mjs, env: RUNNER_CONFIG_PATH)
  -d, --database   SQLite Database URL (env: RUNNER_DATABASE_URL)
  -p, --port       Port for Webhook Ingress Server (default: 11235, env: PORT)
  -k, --workers    Maximum concurrent jobs (default: 5, env: RUNNER_WORKERS)
                  Worker tags (comma-separated env: RUNNER_TAGS)
                  Webhook server URL (env: RUNNER_SERVER_URL)
  -h, --help       Show this help message
  `);
}

export async function loadFromArgs(): Promise<{ config: RunnerConfig | null; command: string }> {
  const { values, positionals } = parseArgs({
    allowPositionals: true,
    options: {
      config: { type: 'string', short: 'c', default: process.env.RUNNER_CONFIG_FILE || './runner.config.mjs' },
      database: { type: 'string', short: 'd' },
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
