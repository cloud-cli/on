#!/usr/bin/env node

import { readdirSync } from 'node:fs';
import { parseArgs } from 'node:util';
import { RunnerConfig } from './types.js';
import { WebhookServer } from './server.js';
import { WorkflowIncludeResolver } from './parser/include-resolver.js';
import { expandMatrix } from './parser/matrix-expander.js';
import { QueueManager } from './queue.js';
import { SecretStore } from './secrets.js';
import { startWorkers } from './worker.js';
import { loadConfig } from './config.js';

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

async function main() {
  const command = positionals[0] || 'start';
  const config = await loadConfig(values);

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
      await WebhookServer.withPort({
        config,
        queue,
        secrets,
        adminToken: config.adminToken,
        port: config.port,
      });
      break;
    }

    case 'start-workers': {
      console.log(`⚙️ Starting ${config.workers} Worker Loop(s)...`);
      const { queue, secrets } = await init();
      const workerPromises = startWorkers(config.workers, queue, secrets, config);

      break;
    }

    default:
      console.error(`❌ Unknown command: '${command}'`);
      printHelp();
      process.exit(1);
  }
}

main().catch(console.error);
