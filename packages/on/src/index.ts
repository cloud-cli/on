#!/usr/bin/env node

import { parseArgs } from 'node:util';
import path from 'node:path';
import fs, { statSync } from 'node:fs';
import { QueueManager } from './queue/dispatcher.js';
import { SecretStore } from './secrets/store.js';
import { WebhookServer } from './ingress/server.js';
import { WorkflowIncludeResolver } from './parser/include-resolver.js';
import { expandMatrix } from './parser/matrix-expander.js';
import { startWorkers } from './worker.js';
import { YamlLoader } from './parser/yaml-loader.js';

const { values, positionals } = parseArgs({
  allowPositionals: true,
  options: {
    config: { type: 'string', short: 'c', default: './runner.config.mjs' },
    database: { type: 'string', short: 'd', default: process.env.DATABASE_URL },
    workflows: { type: 'string', short: 'w', default: '.on/' },
    port: { type: 'string', short: 'p', default: process.env.PORT },
    workers: { type: 'string', short: 'k', default: '5' },
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
  statt-server    Runs Webhook Ingress Server only (API Gateway mode)
  start-workers   Runs Worker Polling loops only (Scalable Worker mode)
  validate        Parses and validates workflow YAML files without running

Options:
  -c, --config     Path to runner.config.mjs (default: ./runner.config.mjs)
  -d, --database   SQLite Database URL
  -w, --workflows  Path to where your workflows are defined (default: .on/)
  -p, --port       Port for Webhook Ingress Server
  -k, --workers    Number of worker thread loops to spawn
  -h, --help       Show this help message
  `);
}

if (values.help) {
  printHelp();
  process.exit(0);
}

async function loadConfig() {
  const configPath = path.resolve(values.config);
  let config = {
    port: Number(values.port),
    adminToken: process.env.RUNNER_ADMIN_SECRET || '',
    sqliteUrl: values.database,
    workflowsDir: values.workflows,
    workersCount: Number(values.workers),
    storagePath: process.env.RUNNER_TMP || '/tmp/workspaces',
  };

  if (fs.existsSync(configPath)) {
    if (false === statSync(configPath).isFile()) {
      console.error(`Config path ${configPath} is not a file!`);
    } else {
      const userConfig = (await import(configPath)).default;
      config = { ...config, ...userConfig };
    }
  }

  if (!fs.existsSync(config.workflowsDir)) {
    console.warn(`⚠️ Warning: Workflows directory '${config.workflowsDir}' not found.`);
    return null;
  }

  return config;
}

function onValidate(config) {
  console.log('🔍 Validating Workflows in:', config.workflowsDir);
  const resolver = new WorkflowIncludeResolver(config.workflowsDir);
  const files = fs.readdirSync(config.workflowsDir).filter((f) => f.endsWith('.yml') || f.endsWith('.yaml'));

  for (const file of files) {
    const resolved = resolver.resolve(file);
    const expanded = expandMatrix(resolved);
    console.log(`  ✅ ${file} -> Valid! (${expanded.length} job matrix variant(s) generated)`);
  }
}

async function onServe(config, workflows) {
  const { queue, secrets } = await init();

  WebhookServer.withPort({
    queue,
    secrets,
    adminToken: config.adminToken,
    workflows,
    port: config.port,
  });
}

async function onWorkers(config) {
  const { queue, secrets } = await init();
  startWorkers(config.workersCount, queue, secrets, config);
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

  switch (command) {
    case 'validate': {
      onValidate(config);
      break;
    }

    case 'start-server': {
      console.log('🌐 Starting Ingress Gateway...');
      onServe(config, []);
      break;
    }

    case 'start-workers': {
      console.log(`⚙️ Starting ${config.workersCount} Worker Loop(s)...`);
      onWorkers(config);
      break;
    }

    case 'start': {
      console.log('🚀 Starting Full Runner Engine (Ingress + Workers)...');
      const workflows = YamlLoader.from(config.workflowsDir);
      onServe(config, workflows);
      onWorkers(config);
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
