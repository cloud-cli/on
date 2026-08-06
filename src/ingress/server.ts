import http from 'node:http';
import { URL } from 'node:url';
import { QueueManager } from '../queue/dispatcher.js';
import { SecretStore } from '../secrets/store.js';
import { SafeExpressionEvaluator } from '../evaluator/safe-eval.js';
import { GitHubPreprocessor } from './preprocessors/github.js';
import { WebhookPreprocessor, WebhookServerOptions, WorkflowDefinition } from './types.js';
import { HtmlReporter } from '../reporters/html.reporter.js';

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
    const url = new URL(
      req.url || '/',
      `${req.headers['x-forwarded-proto'] || 'http'}://${req.headers['x-forwarded-host'] || req.headers.host}`,
    );

    if (req.method === 'GET' && (url.pathname === '/runs' || url.pathname === '/')) {
      return this.renderDashboard(res);
    }

    if (req.method === 'GET' && url.pathname.startsWith('/runs/')) {
      const jobId = url.pathname.replace('/runs/', '');
      return this.renderRunDetails(jobId, res);
    }

    if (req.method === 'POST' && url.pathname === '/admin/reload-secrets') {
      return this.handleSecretReload(req, res);
    }

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
            const shouldRun = SafeExpressionEvaluator.evaluateCondition(workflow.on.if, { inputs });
            if (!shouldRun) continue;
          } catch (evalErr: any) {
            console.error(`⚠️ Condition evaluation error in workflow [${workflow.id}]:`, evalErr.message);
            continue; // Skip this workflow without crashing server
          }
        }

        // 4. Resolve Concurrency Key (if specified)
        let concurrencyKey: string | undefined;
        if (workflow.concurrency?.group) {
          concurrencyKey = await SafeExpressionEvaluator.evaluateValue(workflow.concurrency.group, { inputs });
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

  /**
   * Serves the Server Health & Jobs Dashboard
   */
  private async renderDashboard(res: http.ServerResponse) {
    const jobs = await this.queue.listJobs(50);

    const rows = jobs
      .map((j) => {
        const badge =
          j.status === 'success'
            ? 'bg-emerald-500/10 text-emerald-400'
            : j.status === 'failed'
              ? 'bg-rose-500/10 text-rose-400'
              : j.status === 'running'
                ? 'bg-indigo-500/10 text-indigo-400 animate-pulse'
                : 'bg-gray-500/10 text-gray-400';

        return `
      <tr class="border-b border-gray-800 hover:bg-gray-900/50 transition">
        <td class="py-3 px-4 font-mono text-indigo-400"><a href="/runs/${j.id}" class="hover:underline">#${j.id}</a></td>
        <td class="py-3 px-4 font-medium text-white">${j.workflow_id}</td>
        <td class="py-3 px-4">
          <span class="px-2.5 py-0.5 rounded-full text-xs font-semibold ${badge}">${j.status.toUpperCase()}</span>
        </td>
        <td class="py-3 px-4 text-xs font-mono text-gray-400">${j.worker_id || '-'}</td>
        <td class="py-3 px-4 text-xs text-gray-400">${j.created_at}</td>
        <td class="py-3 px-4 text-right">
          <a href="/runs/${j.id}" class="text-xs bg-gray-800 hover:bg-gray-700 text-gray-200 px-3 py-1 rounded border border-gray-700">View Trace →</a>
        </td>
      </tr>
    `;
      })
      .join('');

    const html = `<!DOCTYPE html>
<html lang="en" class="dark">
<head>
  <meta charset="UTF-8">
  <meta http-equiv="refresh" content="10"> <!-- Auto-refreshes every 10s -->
  <title>Workflow Engine Dashboard</title>
  <script src="https://cdn.tailwindcss.com"></script>
</head>
<body class="bg-gray-950 text-gray-100 min-h-screen p-6 font-sans">
  <div class="max-w-6xl mx-auto space-y-6">
    <div class="flex items-center justify-between border-b border-gray-800 pb-4">
      <div>
        <h1 class="text-2xl font-bold text-white">⚙️ Runner Engine Status</h1>
        <p class="text-xs text-gray-400">Live SQLite Job Queue & Execution Traces</p>
      </div>
      <span class="text-xs font-mono bg-emerald-500/10 text-emerald-400 px-3 py-1 rounded-full border border-emerald-500/20">
        ● System Operational
      </span>
    </div>

    <div class="bg-gray-900 border border-gray-800 rounded-xl overflow-hidden">
      <table class="w-full text-left text-sm">
        <thead class="bg-gray-800/50 text-gray-400 text-xs uppercase font-mono border-b border-gray-800">
          <tr>
            <th class="py-3 px-4">Job ID</th>
            <th class="py-3 px-4">Workflow</th>
            <th class="py-3 px-4">Status</th>
            <th class="py-3 px-4">Worker</th>
            <th class="py-3 px-4">Created At</th>
            <th class="py-3 px-4 text-right">Action</th>
          </tr>
        </thead>
        <tbody>${rows.length ? rows : '<tr><td colspan="6" class="p-6 text-center text-gray-500">No jobs recorded yet.</td></tr>'}</tbody>
      </table>
    </div>
  </div>
</body>
</html>`;

    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    res.end(html);
  }

  /**
   * Serves single job HTML report
   */
  private async renderRunDetails(jobId: string, res: http.ServerResponse) {
    const job = await this.queue.getJob(jobId);

    if (!job || !job.report) {
      res.writeHead(404, { 'Content-Type': 'text/html; charset=utf-8' });
      return res.end(
        '<h1>404 - Report Not Found</h1><p>Job is still running or does not exist.</p><a href="/runs">← Back to Dashboard</a>',
      );
    }

    const reportData = JSON.parse(job.report);
    const htmlReporter = new HtmlReporter({ outputDir: '' });
    const htmlContent = htmlReporter.generateHtml(reportData);

    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    res.end(htmlContent);
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
