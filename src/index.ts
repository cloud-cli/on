#!/usr/bin/env node

import { existsSync, readdirSync, statSync } from 'node:fs';
import { resolve } from 'node:path';
import { parseArgs } from 'node:util';
import { RunnerConfig, UserRunnerConfig } from './types.js';
import { WebhookServer } from './ingress/server.js';
import { WorkflowIncludeResolver } from './parser/include-resolver.js';
import { expandMatrix } from './parser/matrix-expander.js';
import { YamlLoader } from './parser/yaml-loader.js';
import { QueueManager } from './queue.js';
import { SecretStore } from './secrets.js';
import { startWorkers } from './worker.js';
import { setUrl } from './db-client.js';
import { resolveConfig } from './config.js';

const { values, positionals } = parseArgs({
  allowPositionals: true,
  options: {
    config: { type: 'string', short: 'c', default: process.env.RUNNER_CONFIG_PATH || './runner.config.mjs' },
    database: { type: 'string', short: 'd', default: process.env.RUNNER_DATABASE_URL },
    workflows: { type: 'string', short: 'w', default: process.env.RUNNER_WORKFLOWS_PATH || '.on/' },
    port: { type: 'string', short: 'p', default: String(process.env.PORT || '11235') },
    workers: { type: 'string', short: 'k', default: process.env.RUNNER_WORKERS || '5' },
    help: { type: 'boolean', short: 'h' },
  },
});

function printHelp() {
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
  -w, --workflows  Path to where your workflows are defined (default: .on/, env: RUNNER_WORKFLOWS_PATH)
  -p, --port       Port for Webhook Ingress Server (default: 11235, env: PORT)
  -k, --workers    Number of worker thread loops to spawn (default: 5, env: RUNNER_WORKERS)
  -h, --help       Show this help message
  `);
}

if (values.help) {
  printHelp();
  process.exit(0);
}

async function loadConfig(): Promise<RunnerConfig | null> {
  const configFromCli: UserRunnerConfig = {
    port: Number(values.port),
    sqliteUrl: values.database,
    workflowsDir: values.workflows,
    workersCount: values.workers ? Number(values.workers) : undefined,
  };

  let configFromFile = {};
  const configPath = resolve(values.config);

  if (existsSync(configPath) && statSync(configPath).isFile()) {
    configFromFile = (await import(configPath)).default || {};
  }

  const config = resolveConfig(configFromFile, configFromCli);

  if (!existsSync(config.workflowsDir)) {
    console.warn(`⚠️ Warning: Workflows directory '${config.workflowsDir}' not found.`);
    return null;
  }

  setUrl(config.sqliteUrl);

  return config;
}

function onValidate(config: RunnerConfig) {
  console.log('🔍 Validating Workflows in:', config.workflowsDir);
  const resolver = new WorkflowIncludeResolver(config.workflowsDir);
  const files = readdirSync(config.workflowsDir).filter((f) => f.endsWith('.yml') || f.endsWith('.yaml'));

  for (const file of files) {
    const resolved = resolver.resolve(file);
    const expanded = expandMatrix(resolved);
    console.log(`  ✅ ${file} -> Valid! (${expanded.length} job matrix variant(s) generated)`);
  }
}

async function init() {
  const secrets = new SecretStore('./.env');
  const queue = new QueueManager('cli-node');
  await queue.init();

  return { secrets, queue };
}

async function main() {
  const command = positionals[0] || 'start';
  const config = await loadConfig();

  if (!config) {
    process.exit(1);
  }

  switch (command) {
    case 'validate': {
      onValidate(config);
      break;
    }

    case 'start-server': {
      console.log('🌐 Starting Ingress Gateway...');
      const { queue, secrets } = await init();
      WebhookServer.withPort({ queue, secrets, adminToken: config.adminToken, workflows: [], port: config.port });
      break;
    }

    case 'start-workers': {
      console.log(`⚙️ Starting ${config.workersCount} Worker Loop(s)...`);
      const { queue, secrets } = await init();
      startWorkers(config.workersCount, queue, secrets, config);
      break;
    }

    case 'start': {
      console.log('🚀 Starting Full Runner Engine (Ingress + Workers)...');
      const workflows = await YamlLoader.from(config.workflowsDir);
      const { queue, secrets } = await init();
      WebhookServer.withPort({ queue, secrets, adminToken: config.adminToken, workflows, port: config.port });
      startWorkers(config.workersCount, queue, secrets, config);
      break;
    }

    default:
      console.error(`❌ Unknown command: '${command}'`);
      printHelp();
      process.exit(1);
  }
}

const cleanupAndExit = async (signal: string) => {
  console.log(`\n🛑 Received ${signal}. Gracefully shutting down workers...`);
  // Cancel active jobs / close DB connections here
  process.exit(0);
};

process.on('SIGINT', () => cleanupAndExit('SIGINT'));
process.on('SIGTERM', () => cleanupAndExit('SIGTERM'));

main().catch(console.error);
