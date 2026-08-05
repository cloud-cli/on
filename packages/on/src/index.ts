import path from 'node:path';
import fs from 'node:fs';
import { QueueManager } from './queue/dispatcher.js';
import { SecretStore } from './secrets/store.js';
import { WebhookServer, type WorkflowDefinition } from './ingress/server.js';
import { WorkflowIncludeResolver } from './parser/include-resolver.js';
import { expandMatrix } from './parser/matrix-expander.js';
import { startWorkerLoop } from './worker.js';

async function bootstrap() {
  console.log('🚀 Bootstrapping Workflow Runner Engine...\n');

  // 1. Load Host Secrets & Config
  const secrets = new SecretStore('./.env');
  const configPath = path.resolve('./runner.config.mjs');

  let config = {
    port: 3000,
    adminToken: 'super-secret-admin-token',
    sqliteUrl: 'https://server.example.com',
    workflowsDir: './workflows',
    workersCount: 2,
  };

  if (fs.existsSync(configPath)) {
    const loadedConfig = (await import(configPath)).default;
    config = { ...config, ...loadedConfig };
  }

  // 2. Initialize Queue Manager & SQLite Schema
  const queue = new QueueManager('ingress-node');
  await queue.init();
  console.log('✅ SQLite Queue initialized.');

  // 3. Load, Resolve & Expand Workflow YAML Files
  const resolver = new WorkflowIncludeResolver(config.workflowsDir);
  const rawWorkflows: WorkflowDefinition[] = [];

  const workflowFiles = fs.readdirSync(config.workflowsDir).filter((f) => f.endsWith('.yml') || f.endsWith('.yaml'));

  for (const file of workflowFiles) {
    try {
      // Resolve includes & partials
      const resolved = resolver.resolve(file);

      // Expand matrix strategy into concrete job specs
      const expandedWorkflows = expandMatrix(resolved);

      for (const wf of expandedWorkflows) {
        rawWorkflows.push({
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
    } catch (err: any) {
      console.error(`❌ Error parsing workflow '${file}':`, err.message);
    }
  }

  console.log(`📋 Loaded ${rawWorkflows.length} active workflow definitions.`);

  // 4. Start HTTP Webhook Ingress Server
  const server = new WebhookServer({
    queue,
    secrets,
    adminToken: config.adminToken,
    workflows: rawWorkflows,
  });

  await server.listen(config.port);

  // 5. Spin up Worker Polling Loops
  console.log(`⚙️  Spinning up ${config.workersCount} worker thread loops...`);
  for (let i = 1; i <= config.workersCount; i++) {
    startWorkerLoop(`worker-${i}`, queue, secrets, config);
  }

  console.log('\n✨ Workflow Engine is LIVE and ready for incoming webhooks!\n');
}

bootstrap().catch(console.error);
