import http from 'node:http';
import { URL } from 'node:url';
import { QueueManager } from '../queue/dispatcher.js';
import { SecretStore } from '../secrets/store.js';
import { SafeExpressionEvaluator } from '../evaluator/safe-eval.js';
import { GitHubPreprocessor } from './preprocessors/github.js';
import { WebhookPreprocessor, WebhookServerOptions, WorkflowDefinition } from './types.js';

export class WebhookServer {
  private server: http.Server;
  private preprocessors = new Map<string, WebhookPreprocessor>();
  private workflows: WorkflowDefinition[] = [];
  private queue: QueueManager;
  private secrets: SecretStore;
  private adminToken: string;

  static withPort(options: WebhookServerOptions & { port: number }) {
    const { port, ...o } = options;
    return new WebhookServer(o).listen(port);
  }

  constructor(options: WebhookServerOptions) {
    this.queue = options.queue;
    this.secrets = options.secrets;
    this.adminToken = options.adminToken;
    this.workflows = options.workflows;

    // Register built-in preprocessors
    this.registerPreprocessor(new GitHubPreprocessor());

    this.server = http.createServer((req, res) => this.handleRequest(req, res));
  }

  registerPreprocessor(preprocessor: WebhookPreprocessor) {
    this.preprocessors.set(preprocessor.name, preprocessor);
  }

  private async handleRequest(req: http.IncomingMessage, res: http.ServerResponse) {
    const url = new URL(req.url || '/', `http://${req.headers.host}`);

    // Route 1: Zero-Downtime Secret Reload
    if (req.method === 'POST' && url.pathname === '/admin/reload-secrets') {
      return this.handleSecretReload(req, res);
    }

    // Route 2: Dynamic Webhook Ingress (/webhooks/:provider)
    if (req.method === 'POST' && url.pathname.startsWith('/webhooks/')) {
      const provider = url.pathname.replace('/webhooks/', '');
      return this.handleWebhook(provider, req, res);
    }

    // Fallback 404
    res.writeHead(404, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'Endpoint not found' }));
  }

  /**
   * Processes incoming HTTP webhooks
   */
  private async handleWebhook(provider: string, req: http.IncomingMessage, res: http.ServerResponse) {
    try {
      // 5MB
      const MAX_PAYLOAD_SIZE = 5 * 1024 * 1024;
      const chunks: Buffer[] = [];
      let receivedBytes = 0;

      for await (const chunk of req) {
        receivedBytes += chunk.length;
        if (receivedBytes > MAX_PAYLOAD_SIZE) {
          res.writeHead(413, { 'Content-Type': 'application/json' });
          return res.end(JSON.stringify({ error: 'Payload size exceeds limit' }));
        }

        chunks.push(typeof chunk === 'string' ? Buffer.from(chunk) : chunk);
      }

      const rawBuffer = Buffer.concat(chunks);

      let body: any = {};
      try {
        body = JSON.parse(rawBuffer.toString('utf-8'));
      } catch {}

      const headers = Object.fromEntries(
        Object.entries(req.headers).map(([k, v]) => [k.toLowerCase(), Array.isArray(v) ? v[0] : v || '']),
      );

      const preprocessor = this.preprocessors.get(provider);
      const secret = this.secrets.get(`${provider.toUpperCase()}_WEBHOOK_SECRET`);

      let isValid = true;
      let inputs: Record<string, any> = { ...body };

      if (preprocessor) {
        const result = preprocessor.parse(headers, body, rawBuffer, secret);
        isValid = result.isValid;
        inputs = result.inputs;
      }

      // Reject unauthorized requests immediately
      if (!isValid) {
        res.writeHead(401, { 'Content-Type': 'application/json' });
        return res.end(JSON.stringify({ error: 'Invalid HMAC signature or authentication failed' }));
      }

      // 3. Match Incoming Webhook to Registered Workflows
      const triggeredJobs: string[] = [];

      for (const workflow of this.workflows) {
        // Match provider (e.g. 'github')
        if (workflow.on.provider !== provider) continue;

        // Evaluate workflow trigger condition if defined (e.g. `if: inputs.event == 'push'`)
        if (workflow.on.if) {
          try {
            const shouldRun = SafeExpressionEvaluator.evaluate(workflow.on.if, { inputs });
            if (!shouldRun) continue;
          } catch (evalErr: any) {
            console.error(`⚠️ Condition evaluation error in workflow [${workflow.id}]:`, evalErr.message);
            continue; // Skip this workflow without crashing server
          }
        }

        // 4. Resolve Concurrency Key (if specified)
        let concurrencyKey: string | undefined;
        if (workflow.concurrency?.group) {
          concurrencyKey = SafeExpressionEvaluator.evaluate(workflow.concurrency.group, { inputs });
        }

        // 5. Enqueue Job to SQLite
        const jobPayload = {
          workflowId: workflow.id,
          steps: workflow.steps,
          inputs,
        };

        await this.queue.enqueue(workflow.id, jobPayload, concurrencyKey);
        triggeredJobs.push(workflow.id);
      }

      // 6. Respond Fast (202 Accepted)
      res.writeHead(202, { 'Content-Type': 'application/json' });
      res.end(
        JSON.stringify({
          message: 'Webhook processed',
          triggeredWorkflows: triggeredJobs,
        }),
      );
    } catch (err: any) {
      console.error('❌ Webhook Ingress Error:', err);
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Internal Ingress Error', details: err.message }));
    }
  }

  /**
   * Handles Zero-Downtime Secret Reload
   */
  private async handleSecretReload(req: http.IncomingMessage, res: http.ServerResponse) {
    const authHeader = req.headers['authorization'];
    if (authHeader !== `Bearer ${this.adminToken}`) {
      res.writeHead(403, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({ error: 'Unauthorized' }));
    }

    // Trigger in-memory secret reload
    this.secrets.reload();
    console.log('🔄 SecretStore reloaded successfully without downtime!');

    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ message: 'Secrets reloaded successfully' }));
  }

  listen(port: number): Promise<void> {
    return new Promise((resolve) => {
      this.server.listen(port, () => {
        console.log(`🌐 Webhook Ingress Server running on port ${port}`);
        resolve();
      });
    });
  }
}
