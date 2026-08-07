#!/usr/bin/env node

import { existsSync, readdirSync, statSync } from 'node:fs';
import { resolve } from 'node:path';
import { parseArgs } from 'node:util';
import { RunnerConfig, UserRunnerConfig } from './types.js';
import { WebhookServer } from './server.js';
import { WorkflowIncludeResolver } from './parser/include-resolver.js';
import { expandMatrix } from './parser/matrix-expander.js';
import { YamlLoader } from './parser/yaml-loader.js';
import { QueueManager } from './queue.js';
import { SecretStore } from './secrets.js';
import { startWorkers } from './worker.js';
import { setUrl } from './db-client.js';
import { shutdownState } from './worker.js';

let serverInstance: WebhookServer | null = null;
let activeWorkerPromises: Promise<void>[] = [];

export { HtmlReporter } from './reporters/html.reporter.js';
export { JsonFileReporter } from './reporters/json-file.reporter.js';
export { SlackReporter } from './reporters/slack.reporter.js';

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
  -w, --workflows  Path to where your workflows are defined (default: on/, env: RUNNER_WORKFLOWS_PATH)
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

function onValidate(config: RunnerConfig) {
  console.log('🔍 Validating Workflows in:', config.workflows);
  const resolver = new WorkflowIncludeResolver(config.workflows);
  const files = readdirSync(config.workflows).filter((f) => f.endsWith('.yml') || f.endsWith('.yaml'));

  for (const file of files) {
    const resolved = resolver.resolve(file);
    const expanded = expandMatrix(resolved);
    console.log(`  ✅ ${file} -> Valid! (${expanded.length} job matrix variant(s) generated)`);
  }
}

async function init() {
  const secrets = new SecretStore('./.env');
  const queue = new QueueManager(process.env.WORKER_NAME || 'cli');
  await queue.init();

  return { secrets, queue };
}

function resolveConfig(configFromFile: UserRunnerConfig, configFromCli: UserRunnerConfig): RunnerConfig {
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

// Complete Graceful Shutdown Handler
let isShuttingDown = false;

const cleanupAndExit = async (signal: string) => {
  if (isShuttingDown) return; // Prevent duplicate execution on double Ctrl+C
  isShuttingDown = true;

  console.log(`\n🛑 Received ${signal}. Initiating graceful shutdown...`);

  // 1. Force exit fallback timer (10s max) if process gets stuck on a lingering child
  const forceExitTimeout = setTimeout(() => {
    console.error('⚠️ Graceful shutdown timed out after 10s. Forcing exit!');
    process.exit(1);
  }, 10000);
  forceExitTimeout.unref();

  try {
    // 2. Stop accepting new webhooks
    if (serverInstance) {
      await serverInstance.stop();
    }

    // 3. Signal workers to stop taking new jobs
    shutdownState.isStopping = true;

    // 4. Wait for running worker loops to complete their current job step
    if (activeWorkerPromises.length > 0) {
      console.log('⚙️ Waiting for active worker jobs to drain...');
      await Promise.allSettled(activeWorkerPromises);
    }

    console.log('✨ Engine stopped cleanly. Goodbye!');
    process.exit(0);
  } catch (err: any) {
    console.error('❌ Error during graceful shutdown:', err.message);
    process.exit(1);
  }
};

process.on('SIGINT', () => cleanupAndExit('SIGINT'));
process.on('SIGTERM', () => cleanupAndExit('SIGTERM'));

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
      serverInstance = await WebhookServer.withPort({
        queue,
        secrets,
        adminToken: config.adminToken,
        workflows: [],
        port: config.port,
      });
      break;
    }

    case 'start-workers': {
      console.log(`⚙️ Starting ${config.workers} Worker Loop(s)...`);
      const { queue, secrets } = await init();
      activeWorkerPromises = startWorkers(config.workers, queue, secrets, config);
      break;
    }

    case 'start': {
      console.log('🚀 Starting Full Runner Engine (Ingress + Workers)...');
      const workflows = await YamlLoader.from(config.workflows);
      const { queue, secrets } = await init();
      serverInstance = await WebhookServer.withPort({
        queue,
        secrets,
        adminToken: config.adminToken,
        workflows,
        port: config.port,
      });
      activeWorkerPromises = startWorkers(config.workers, queue, secrets, config);
      break;
    }

    default:
      console.error(`❌ Unknown command: '${command}'`);
      printHelp();
      process.exit(1);
  }
}

main().catch(console.error);
