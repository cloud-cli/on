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
import { generateDashboardHtml, toDashboardJobs } from './dashboard.js';

const DASHBOARD_PAGE_SIZE = 50;
const MAX_DASHBOARD_PAGE_SIZE = 500;
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

    if (req.method === 'GET' && url.pathname === '/api/jobs') {
      const afterIdParam = url.searchParams.get('afterId');
      const beforeIdParam = url.searchParams.get('beforeId');
      const limitParam = url.searchParams.get('limit');
      const afterId = afterIdParam === null ? undefined : Number(afterIdParam);
      const beforeId = beforeIdParam === null ? undefined : Number(beforeIdParam);
      const limit = limitParam === null ? DASHBOARD_PAGE_SIZE : Number(limitParam);

      if (afterId !== undefined && (!Number.isSafeInteger(afterId) || afterId < 0)) {
        res.writeHead(400, { 'Content-Type': 'application/json; charset=utf-8' });
        return res.end(JSON.stringify({ error: 'afterId must be a non-negative integer' }));
      }
      if (beforeId !== undefined && (!Number.isSafeInteger(beforeId) || beforeId < 1)) {
        res.writeHead(400, { 'Content-Type': 'application/json; charset=utf-8' });
        return res.end(JSON.stringify({ error: 'beforeId must be a positive integer' }));
      }
      if (!Number.isSafeInteger(limit) || limit < 1 || limit > MAX_DASHBOARD_PAGE_SIZE) {
        res.writeHead(400, { 'Content-Type': 'application/json; charset=utf-8' });
        return res.end(JSON.stringify({ error: `limit must be an integer from 1 to ${MAX_DASHBOARD_PAGE_SIZE}` }));
      }

      return this.renderDashboardJobs(res, limit, afterId, beforeId);
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

      const preprocessor = this.preprocessors.get(provider);
      if (preprocessor?.filter && !preprocessor.filter(inputs, workflow.on).isValid) {
        console.log(`⏩ Skipped ${workflow.id} based on ${provider} webhook filters`, { inputs });
        continue;
      }

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
    const rows = await this.queue.listJobs(DASHBOARD_PAGE_SIZE + 1);
    const jobs = toDashboardJobs(rows.slice(0, DASHBOARD_PAGE_SIZE));
    const redacted = this.secrets.redactText(generateDashboardHtml(jobs, rows.length > DASHBOARD_PAGE_SIZE));
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    res.end(redacted);
  }

  private async renderDashboardJobs(res: http.ServerResponse, limit: number, afterId?: number, beforeId?: number) {
    const rows = await this.queue.listJobs(limit + 1, afterId, beforeId);
    const jobs = toDashboardJobs(rows.slice(0, limit));
    const body = this.secrets.redactText(JSON.stringify({ jobs, hasMore: rows.length > limit }));
    res.writeHead(200, {
      'Cache-Control': 'no-store',
      'Content-Type': 'application/json; charset=utf-8',
    });
    res.end(body);
  }

  /**
   * Serves single job HTML report
   */
  private async renderRunDetails(jobId: string, res: http.ServerResponse) {
    const job = await this.queue.getJob(jobId);

    if (!job) {
      res.writeHead(404, { 'Content-Type': 'text/html; charset=utf-8' });
      return res.end('<h1>404 - Report Not Found</h1>');
    }

    const reportData = job.report
      ? (JSON.parse(job.report) as WorkflowExecutionReport)
      : this.buildPendingReport(job);

    reportData.status = job.status;
    if (reportData.status === 'running') {
      reportData.durationMs = Math.max(0, Date.now() - Date.parse(reportData.startedAt));
    }

    // Fetch logs on-demand
    const logsMap = await this.queue.getJobLogs(jobId);

    // Attach log content back onto step objects for rendering
    reportData.steps = (reportData.steps || []).map((step: any) => ({
      ...step,
      logContent: step.status === 'running' || step.status === 'pending' ? '' : logsMap[step.id] || '',
    }));

    const htmlReporter = new HtmlReporter({ outputDir: '' });
    const htmlContent = htmlReporter.generateHtml(reportData);
    const redacted = this.secrets.redactText(htmlContent);

    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    res.end(redacted);
  }

  private buildPendingReport(job: any): WorkflowExecutionReport {
    const payload = JSON.parse(job.payload) as JobPayload;
    const startedAt = job.started_at || job.created_at;

    return {
      jobId: String(job.id),
      parentId: String(job.parentId || ''),
      workflowName: job.workflow_id,
      status: job.status,
      durationMs: job.status === 'running' ? Math.max(0, Date.now() - Date.parse(startedAt)) : 0,
      startedAt,
      inputs: payload.inputs || {},
      environment: payload.env || {},
      steps: (payload.steps || []).map((step, index) => ({
        id: step.id || `step-${index}`,
        name: step.name || step.id || `step-${index}`,
        status: 'pending',
        durationMs: 0,
        outputs: {},
        logContent: '',
      })),
      artifacts: [],
      rerunToken: JSON.stringify({ jobId: job.id, payload }),
    };
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
