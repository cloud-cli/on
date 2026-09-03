import http from 'node:http';
import { URL } from 'node:url';
import { QueueManager } from './queue.js';
import { SecretStore } from './secrets.js';
import { SafeExpressionEvaluator } from './safe-eval.js';
import { GitHubPreprocessor } from './preprocessors/github.js';
import type {
  JobPayload,
  WebhookPreprocessor,
  WebhookServerOptions,
  WorkflowDefinition,
  WorkflowExecutionReport,
} from './types.js';
import { HtmlReporter } from './reporters/html.reporter.js';
import { YamlLoader } from './parser/yaml-loader.js';
export class WebhookServer {
  private server: http.Server;
  private preprocessors = new Map<string, WebhookPreprocessor>();
  private workflows: WorkflowDefinition[] = [];
  private queue: QueueManager;
  private secrets: SecretStore;
  private adminToken: string;

  static async withPort(options: WebhookServerOptions & { port: number }) {
    const { port, ...o } = options;
    return new WebhookServer(o).listen(port);
  }

  constructor(options: WebhookServerOptions) {
    this.queue = options.queue;
    this.secrets = options.secrets;
    this.adminToken = options.adminToken;

    YamlLoader.from(options.config.workflows).then((loadedWorkflows) => {
      this.workflows = loadedWorkflows;
      console.log(`✅ Loaded ${loadedWorkflows.length} workflow(s) from ${options.config.workflows}`);
    });

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

    if (req.method === 'POST' && url.pathname.startsWith('/restart/')) {
      const jobId = url.pathname.replace('/restart/', '');
      return this.handleRestartJob(jobId, res);
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
      const { rawBuffer, headers } = await this.readRequest(req, res);

      if (res.headersSent || !rawBuffer) return;

      const { isValid, inputs } = this.preprocess(provider, headers, rawBuffer);

      if (!isValid) {
        res.writeHead(401, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Invalid HMAC signature or authentication failed' }));
        return;
      }

      this.matchWorkflows(provider, inputs);

      res.writeHead(202, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ message: 'OK' }));
    } catch (err: any) {
      console.error('❌ Webhook Ingress Error:', err);
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Internal Ingress Error', details: err.message }));
    }
  }

  private async readRequest(req: http.IncomingMessage, res: http.ServerResponse) {
    const MAX_PAYLOAD_SIZE = 5 * 1024 * 1024; // 5MB
    const chunks: Buffer[] = [];
    let receivedBytes = 0;

    for await (const chunk of req) {
      receivedBytes += chunk.length;
      if (receivedBytes > MAX_PAYLOAD_SIZE) {
        res.writeHead(413, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Payload size exceeds limit' }));
        return { rawBuffer: null, headers: {} };
      }

      chunks.push(typeof chunk === 'string' ? Buffer.from(chunk) : chunk);
    }

    const rawBuffer = Buffer.concat(chunks);
    const headers = Object.fromEntries(
      Object.entries(req.headers).map(([k, v]) => [k.toLowerCase(), Array.isArray(v) ? v[0] : v || '']),
    );

    return { rawBuffer, headers };
  }

  private preprocess(provider: string, headers, rawBuffer: Buffer) {
    const secret = this.secrets.get(`${provider.toUpperCase()}_WEBHOOK_SECRET`);
    const preprocessor = this.preprocessors.get(provider);
    try {
      if (preprocessor) {
        const result = preprocessor.parse(headers, rawBuffer, secret);
        const { inputs, isValid } = result;
        return { inputs, isValid };
      }

      const inputs = JSON.parse(rawBuffer.toString('utf-8'));
      return { isValid: true, inputs };
    } catch {
      return { isValid: false, inputs: null };
    }
  }

  private async matchWorkflows(provider: string, inputs: any) {
    for (const workflow of this.workflows) {
      if (workflow.on.provider !== provider) continue;

      if (workflow.on.if) {
        try {
          const shouldRun = await SafeExpressionEvaluator.evaluateConditions(workflow.on.if, { inputs });

          if (!shouldRun) {
            console.log(`⏩ Skipped ${workflow.id} based on conditions: ${workflow.on.if}`, { inputs });
            continue;
          }
        } catch (evalErr: any) {
          console.error(`⚠️ Condition evaluation error in workflow [${workflow.id}]:`, evalErr.message);
          continue; // Skip this workflow without crashing server
        }
      }

      let concurrencyKey = '';

      if (workflow.concurrency?.group) {
        concurrencyKey = await SafeExpressionEvaluator.evaluateValue(workflow.concurrency.group, { inputs });
      }

      const jobPayload: JobPayload = {
        workflowId: workflow.id,
        env: workflow.env,
        steps: workflow.steps,
        inputs,
      };

      await this.queue.enqueue(workflow.id, jobPayload, concurrencyKey);
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
    const jobs = await this.queue.listJobs(500);
    const badgeMap = {
      success: 'bg-emerald-500/10 text-emerald-400',
      failed: 'bg-rose-500/10 text-rose-400',
      running: 'bg-indigo-500/10 text-indigo-400 animate-pulse',
      _: 'bg-gray-500/10 text-gray-400',
    };

    const dotColor = (status: string | undefined) => {
      switch (status) {
        case 'success':
          return 'bg-emerald-400';
        case 'failed':
          return 'bg-rose-400';
        case 'running':
          return 'bg-indigo-400 animate-pulse';
        default:
          return 'bg-gray-500';
      }
    };

    const mobileCards = jobs
      .map((j) => {
        const dot = dotColor(j.status);
        return `
      <div class="py-3 px-4 block md:hidden bg-gray-900/60">
        <div class="flex items-center justify-between gap-2 mb-1">
          <div class="flex items-center gap-2 min-w-0">
            <span class="w-2.5 h-2.5 rounded-full ${dot} flex-shrink-0"></span>
            <span class="font-medium text-white truncate">${j.workflow_id}</span>
          </div>
          <a href="/runs/${j.id}" class="shrink-0 text-xs bg-gray-800 hover:bg-gray-700 text-gray-300 px-2.5 py-1 rounded border border-gray-700 whitespace-nowrap">Trace</a>
        </div>
        <div class="flex items-center gap-2 text-xs text-gray-400 pl-[18px]">
          #${j.id}
        </div>
      </div>
    `;
      })
      .join('');

    const desktopRows = jobs
      .map((j) => {
        const badge = badgeMap[j.status] || badgeMap['_'];
        return `
      <tr class="border-b border-gray-800 hover:bg-gray-900/50 transition">
        <td class="py-3 px-4 font-mono text-indigo-400"><a href="/runs/${j.id}" class="hover:underline">#${j.id}</a></td>
        <td class="py-3 px-4 font-medium text-white">${j.workflow_id}</td>
        <td class="py-3 px-4">
          <span class="px-2.5 py-0.5 rounded-full text-xs font-semibold ${badge}">${j.status?.toUpperCase() ?? '?'}</span>
        </td>
        <td class="py-3 px-4 hidden xl:table-cell text-xs font-mono text-gray-400">${j.worker_id || '-'}</td>
        <td class="py-3 px-4 hidden lg:table-cell text-xs text-gray-400">${j.created_at}</td>
        <td class="py-3 px-4 text-right whitespace-nowrap hidden md:table-cell">
          <a href="/runs/${j.id}" class="text-xs bg-gray-800 hover:bg-gray-700 text-gray-200 px-3 py-1 rounded border border-gray-700">View Trace →</a>
        </td>
      </tr>
    `;
      })
      .join('');

    const html = `<!doctype html>
<html lang="en" class="dark">
  <head>
  <meta charset="utf-8" />
  <meta http-equiv="X-UA-Compatible" content="IE=edge" />
  <meta name="viewport" content="width=device-width,initial-scale=1.0" />
  <meta http-equiv="refresh" content="10"> <!-- Auto-refreshes every 10s -->
  <title>Workflow Engine Dashboard</title>
  <script src="https://cdn.tailwindcss.com"></script>
</head>
<body class="bg-gray-950 text-gray-100 min-h-screen p-6 font-sans">
  <div class="max-w-6xl mx-auto space-y-6">
    <div class="flex items-center justify-between border-b border-gray-800 pb-4">
      <div>
        <h1 class="text-2xl font-bold text-white">⚙️ Runner Engine Status</h1>
        <p class="text-xs text-gray-400">Live Job Queue & Execution Traces</p>
      </div>
      <span class="text-xs font-mono bg-emerald-500/10 text-emerald-400 px-3 py-1 rounded-full border border-emerald-500/20">
        ● System Operational
      </span>
    </div>

    <div class="bg-gray-900 border border-gray-800 rounded-xl overflow-hidden hidden md:block">
      <table class="w-full text-left text-sm">
        <thead class="bg-gray-800/50 text-gray-400 text-xs uppercase font-mono border-b border-gray-800">
          <tr>
            <th class="py-3 px-4">Job ID</th>
            <th class="py-3 px-4">Workflow</th>
            <th class="py-3 px-4">Status</th>
            <th class="py-3 px-4 hidden xl:table-cell">Worker</th>
            <th class="py-3 px-4 hidden lg:table-cell">Created At</th>
            <th class="py-3 px-4 text-right hidden md:table-cell">Action</th>
          </tr>
        </thead>
        <tbody>${desktopRows}</tbody>
      </table>
    </div>

    <div class="md:hidden divide-y divide-gray-800">${mobileCards || '<div class="p-6 text-center text-gray-500">No jobs recorded yet.</div>'}</div>
  </div>
</body>
</html>`;

    const redacted = this.secrets.redactText(html);
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    res.end(redacted);
  }

  /**
   * Serves single job HTML report
   */
  private async renderRunDetails(jobId: string, res: http.ServerResponse) {
    const job = await this.queue.getJob(jobId);

    if (!job || !job.report) {
      res.writeHead(404, { 'Content-Type': 'text/html; charset=utf-8' });
      return res.end('<h1>404 - Report Not Found</h1>');
    }

    const reportData = JSON.parse(job.report) as WorkflowExecutionReport;

    // Fetch logs on-demand
    const logsMap = await this.queue.getJobLogs(jobId);

    // Attach log content back onto step objects for rendering
    reportData.steps = (reportData.steps || []).map((step: any) => ({
      ...step,
      logContent: logsMap[step.id] || '',
    }));

    const htmlReporter = new HtmlReporter({ outputDir: '' });
    const htmlContent = htmlReporter.generateHtml(reportData);
    const redacted = this.secrets.redactText(htmlContent);

    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    res.end(redacted);
  }

  private async handleRestartJob(jobId: string, res: http.ServerResponse) {
    const id = await this.queue.restartJob(jobId);

    if (id) {
      res.writeHead(201, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ id }));
      return;
    }

    res.writeHead(404, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'Job not found' }));
  }

  listen(port: number): Promise<WebhookServer> {
    return new Promise((resolve) => {
      this.server.listen(port, process.env.RUNNER_HOST || '0.0.0.0', () => {
        console.log(`🌐 Webhook Ingress Server running on port ${port}`);
        resolve(this);
      });
    });
  }

  async stop(): Promise<void> {
    return new Promise((resolve) => {
      this.server.close(() => {
        console.log('🌐 Webhook Ingress Server stopped listening.');
        resolve();
      });
    });
  }
}
