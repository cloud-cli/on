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
import { YamlLoader } from './parser/loader.js';

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

const command = positionals[0] || 'start';

function printHelp() {
  console.log(`
🏃 Runner CLI 🏃

Usage:
  on <command> [options]

Commands:
  start       Runs both Webhook Ingress Server and Workers (Default)
  server      Runs Webhook Ingress Server only (API Gateway mode)
  worker      Runs Worker Polling loops only (Scalable Worker mode)
  validate    Parses and validates workflow YAML files without running

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

  return config;
}

async function main() {
  const config = await loadConfig();
  const secrets = new SecretStore('./.env');
  const queue = new QueueManager('cli-node');
  await queue.init();

  switch (command) {
    case 'validate': {
      console.log('🔍 Validating Workflows in:', config.workflowsDir);
      const resolver = new WorkflowIncludeResolver(config.workflowsDir);
      const files = fs.readdirSync(config.workflowsDir).filter((f) => f.endsWith('.yml') || f.endsWith('.yaml'));

      for (const file of files) {
        const resolved = resolver.resolve(file);
        const expanded = expandMatrix(resolved);
        console.log(`  ✅ ${file} -> Valid! (${expanded.length} job matrix variant(s) generated)`);
      }
      break;
    }

    case 'server': {
      console.log('🌐 Starting Ingress Gateway mode...');
      const server = new WebhookServer({
        queue,
        secrets,
        adminToken: config.adminToken,
        workflows: [],
      });
      await server.listen(config.port);
      break;
    }

    case 'worker': {
      console.log(`⚙️ Starting ${config.workersCount} Worker Loop(s)...`);
      startWorkers(config.workersCount, queue, secrets, config);
      break;
    }

    case 'start': {
      console.log('🚀 Starting Full Runner Engine (Ingress + Workers)...');

      const workflows = YamlLoader.from(config.workflowsDir);
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

main().catch(console.error);
