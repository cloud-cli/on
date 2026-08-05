#!/usr/bin/env node

import { parseArgs } from 'node:util';
import path from 'node:path';
import fs from 'node:fs';
import { QueueManager } from './queue/dispatcher.js';
import { SecretStore } from './secrets/store.js';
import { WebhookServer } from './ingress/server.js';
import { WorkflowIncludeResolver } from './parser/include-resolver.js';
import { expandMatrix } from './parser/matrix-expander.js';
import { startWorkerLoop } from './worker.js';

// Parse command line arguments
const { values, positionals } = parseArgs({
  allowPositionals: true,
  options: {
    config: { type: 'string', short: 'c', default: './runner.config.mjs' },
    port: { type: 'string', short: 'p' },
    workers: { type: 'string', short: 'w' },
    help: { type: 'boolean', short: 'h' },
  },
});

const command = positionals[0] || 'start';

function printHelp() {
  console.log(`
🏃 My-Runner CLI Engine

Usage:
  my-runner <command> [options]

Commands:
  start       Runs both Webhook Ingress Server and Workers (Default)
  server      Runs Webhook Ingress Server only (API Gateway mode)
  worker      Runs Worker Polling loops only (Scalable Worker mode)
  validate    Parses and validates workflow YAML files without running

Options:
  -c, --config   Path to runner.config.mjs (default: ./runner.config.mjs)
  -p, --port     Port for Webhook Ingress Server
  -w, --workers  Number of worker thread loops to spawn
  -h, --help     Show this help message
  `);
}

if (values.help) {
  printHelp();
  process.exit(0);
}

async function loadConfig() {
  const configPath = path.resolve(values.config || './runner.config.mjs');
  let config = {
    port: 3000,
    adminToken: 'admin-secret',
    sqliteUrl: 'https://server.example.com',
    workflowsDir: './workflows',
    workersCount: 2,
    storagePath: '/tmp/workspaces',
  };

  if (fs.existsSync(configPath)) {
    const userConfig = (await import(configPath)).default;
    config = { ...config, ...userConfig };
  }

  // Override config with CLI flags if explicitly passed
  if (values.port) config.port = parseInt(values.port, 10);
  if (values.workers) config.workersCount = parseInt(values.workers, 10);

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
      for (let i = 1; i <= config.workersCount; i++) {
        startWorkerLoop(`worker-${i}`, queue, secrets, config);
      }
      break;
    }

    case 'start': {
      console.log('🚀 Starting Full Runner Engine (Ingress + Workers)...');

      // Load workflows
      const resolver = new WorkflowIncludeResolver(config.workflowsDir);
      const files = fs.readdirSync(config.workflowsDir).filter((f) => f.endsWith('.yml') || f.endsWith('.yaml'));
      const workflows: any[] = [];

      for (const file of files) {
        const resolved = resolver.resolve(file);
        const expanded = expandMatrix(resolved);
        for (const wf of expanded) {
          workflows.push({
            id: wf.id || wf.name.toLowerCase().replace(/[^a-z0-9]/g, '-'),
            name: wf.name,
            on: {
              provider: Object.keys(wf.on || {})[0] || 'generic',
              if: wf.on?.[Object.keys(wf.on || {})[0]]?.if,
            },
            concurrency: wf.concurrency,
            steps: wf.steps,
          });
        }
      }

      // Start Ingress Server
      const server = new WebhookServer({
        queue,
        secrets,
        adminToken: config.adminToken,
        workflows,
      });
      await server.listen(config.port);

      // Start Workers
      for (let i = 1; i <= config.workersCount; i++) {
        startWorkerLoop(`worker-${i}`, queue, secrets, config);
      }
      break;
    }

    default:
      console.error(`❌ Unknown command: '${command}'`);
      printHelp();
      process.exit(1);
  }
}

main().catch(console.error);
