#!/usr/bin/env node

import { loadFromArgs, printHelp } from './config.js';
import { installTimestampedConsole } from './logger.js';

export { GitHubStatusPlugin } from './plugins/github-status.plugin.js';
export { createWorkflowPlugin, registerWorkflowPlugin } from './plugins/workflow-registry.js';

async function main() {
  installTimestampedConsole();
  const { config, command } = await loadFromArgs();

  if (!config) {
    process.exitCode = 1;
    return;
  }

  const [{ QueueManager }, { SecretStore }, { WebhookServer }, { startWorkers }, { WorkflowRepository }, { WorkflowScheduler }] = await Promise.all([
    import('./queue.js'),
    import('./secrets.js'),
    import('./server.js'),
    import('./worker.js'),
    import('./workflows.js'),
    import('./scheduler.js'),
  ]);

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

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
