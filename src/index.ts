#!/usr/bin/env node

import { readdirSync } from 'node:fs';
import { loadFromArgs, printHelp } from './config.js';
import { WorkflowIncludeResolver } from './parser/include-resolver.js';
import { expandMatrix } from './parser/matrix-expander.js';
import { QueueManager } from './queue.js';
import { SecretStore } from './secrets.js';
import { WebhookServer } from './server.js';
import { RunnerConfig } from './types.js';
import { startWorkers } from './worker.js';

export { HtmlReporter } from './reporters/html.reporter.js';
export { JsonFileReporter } from './reporters/json-file.reporter.js';
export { SlackReporter } from './reporters/slack.reporter.js';

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

async function main() {
  const { config, command } = await loadFromArgs();

  if (!config) {
    process.exit(1);
  }

  if (command === 'validate') {
    return onValidate(config);
  }

  const secrets = new SecretStore('./.env');
  const queue = new QueueManager(process.env.WORKER_NAME || 'cli');

  switch (command) {
    case 'start-server': {
      console.log('🌐 Starting Ingress Gateway...');
      await queue.init();
      await WebhookServer.withPort({ config, queue, secrets, adminToken: config.adminToken, port: config.port });
      break;
    }

    case 'start-workers': {
      console.log(`⚙️ Starting ${config.workers} Worker Loop(s)...`);
      await queue.init();
      startWorkers(config.workers, queue, secrets, config);
      break;
    }

    default:
      console.error(`❌ Unknown command: '${command}'`);
      printHelp();
      process.exit(1);
  }
}

main().catch(console.error);
