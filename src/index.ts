#!/usr/bin/env node

import { loadFromArgs, printHelp } from './config.js';
import { QueueManager } from './queue.js';
import { SecretStore } from './secrets.js';
import { WebhookServer } from './server.js';
import { startWorkers } from './worker.js';
import { WorkflowRepository } from './workflows.js';
import { WorkflowScheduler } from './scheduler.js';

export { GitHubStatusPlugin } from './plugins/github-status.plugin.js';

async function main() {
  const { config, command } = await loadFromArgs();

  if (!config) {
    process.exit(1);
  }

  const secrets = new SecretStore();
  const queue = new QueueManager(process.env.WORKER_NAME || 'cli');

  switch (command) {
    case 'start-server': {
      console.log('🌐 Starting Ingress Gateway...');
      await queue.init();
      await WebhookServer.withPort({ config, queue, secrets, adminToken: config.adminToken, port: config.port });
      break;
    }

    case 'start-workers': {
      console.log(`⚙️ Starting worker scheduler with ${config.workers} concurrent slot(s)...`);
      await queue.init();
      startWorkers(config.workers, queue, secrets, config);
      break;
    }

    case 'start-scheduler': {
      console.log('Starting workflow scheduler...');
      await queue.init();
      const workflows = new WorkflowRepository();
      await workflows.init();
      const scheduler = new WorkflowScheduler(queue, workflows, config);
      scheduler.start();
      const stop = () => { scheduler.stop(); process.exit(0); };
      process.once('SIGINT', stop);
      process.once('SIGTERM', stop);
      break;
    }

    default:
      console.error(`❌ Unknown command: '${command}'`);
      printHelp();
      process.exit(1);
  }
}

main().catch(console.error);
