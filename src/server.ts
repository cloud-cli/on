import crypto from 'node:crypto';
import http from 'node:http';
import { URL } from 'node:url';
import { dashboardTemplate, generateDashboardHtml, toDashboardJobs } from './dashboard.js';
import { EventBroker } from './events.js';
import { GitHubPreprocessor } from './preprocessors/github.js';
import { appIcon, serviceWorker, webManifest } from './pwa.js';
import { QueueManager } from './queue.js';
import { buildRunView, renderRunHtml } from './run-view.js';
import { SafeExpressionEvaluator } from './safe-eval.js';
import { expandMatrix, resolveMatrixTags } from './parser/matrix-expander.js';
import { SecretRepository } from './secret-repository.js';
import { SecretStore } from './secrets.js';
import { PushRepository } from './push.js';
import { renderHelpHtml } from './help.js';
import openApiSpec from '../openapi.json' with { type: 'json' };
import { ApiKeyRepository } from './api-key-repository.js';
import { generateSettingsHtml } from './settings-ui.js';
import { buildAiHelpMessages, createAiRequest, streamAiHelp } from './ai-help.js';
import appHeaderTemplate from './app-header.html?raw';
import appShellTemplate from './app-shell.html?raw';
import appRouterTemplate from './app-router.html?raw';
import { runTemplate } from './run-view.js';
import type { JobPayload, WebhookPreprocessor, WebhookServerOptions } from './types.js';
import { generateWorkflowManagementHtml } from './workflows-ui.js';
import { WorkflowRepository } from './workflows.js';
import { debug } from './debug.js';

const DASHBOARD_PAGE_SIZE = 50;
const MAX_DASHBOARD_PAGE_SIZE = 500;
export class WebhookServer {
  private server: http.Server;
  private preprocessors = new Map<string, WebhookPreprocessor>();
  private workflows = new WorkflowRepository();
  private secretRepository = new SecretRepository();
  private queue: QueueManager;
  private secrets: SecretStore;
  private push: PushRepository;
  private apiKeys = new ApiKeyRepository();
  private adminToken: string;
  private workerToken: string;
  private events = new EventBroker();
  private workflowsLoaded: Promise<void>;

  static async withPort(options: WebhookServerOptions & { port: number }) {
    const { port, ...o } = options;
    return new WebhookServer(o).listen(port);
  }

  constructor(options: WebhookServerOptions) {
    this.queue = options.queue;
    this.secrets = options.secrets;
    this.push = new PushRepository(options.config);
    this.adminToken = options.adminToken;
    this.workerToken = options.config.workerToken;

    this.workflowsLoaded = Promise.all([this.workflows.init(), this.secretRepository.init(), this.apiKeys.init()]).then(() => undefined);

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

    if (req.method === 'GET' && url.pathname === '/manifest.webmanifest') {
      res.writeHead(200, { 'Cache-Control': 'public, max-age=3600', 'Content-Type': 'application/manifest+json' });
      return res.end(webManifest);
    }

    if (req.method === 'GET' && url.pathname === '/app-icon.svg') {
      res.writeHead(200, { 'Cache-Control': 'public, max-age=86400', 'Content-Type': 'image/svg+xml' });
      return res.end(appIcon);
    }

    if (req.method === 'GET' && url.pathname === '/service-worker.js') {
      res.writeHead(200, { 'Cache-Control': 'no-cache', 'Content-Type': 'text/javascript; charset=utf-8' });
      return res.end(serviceWorker);
    }

    if (req.method === 'GET' && url.pathname === '/app-header.html') {
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' });
      return res.end(appHeaderTemplate);
    }

    if (req.method === 'GET' && url.pathname === '/app-router.html') {
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' });
      return res.end(appRouterTemplate);
    }

    if (req.method === 'GET' && (url.pathname === '/runs' || url.pathname === '/')) {
      return this.renderAppShell(res);
    }

    if (req.method === 'GET' && url.pathname === '/help') {
      if (url.searchParams.get('embed') === '1') {
        res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' });
        return res.end(renderHelpHtml(true));
      }
      return this.renderAppShell(res);
    }

    if (req.method === 'GET' && url.pathname === '/api') {
      res.writeHead(200, { 'Cache-Control': 'no-store', 'Content-Type': 'application/json; charset=utf-8' });
      return res.end(JSON.stringify(openApiSpec));
    }

    if (req.method === 'GET' && url.pathname === '/pages/dashboard.html') {
      return this.renderPageComponent(res, 'page-dashboard', dashboardTemplate);
    }
    if (req.method === 'GET' && url.pathname === '/pages/run.html') {
      return this.renderPageComponent(res, 'page-run', runTemplate);
    }
    if (req.method === 'GET' && url.pathname === '/pages/help.html') {
      return this.renderPageComponent(res, 'page-help', renderHelpHtml(false), true);
    }
    if (req.method === 'GET' && url.pathname === '/pages/workflows.html') {
      if (!this.requireAdmin(req, res)) return;
      const page = url.searchParams.get('page') === 'secrets' ? 'secrets' : url.searchParams.get('page') === 'editor' ? 'editor' : 'workflows';
      const id = url.searchParams.get('id') || '';
      const revision = Number(url.searchParams.get('revision'));
      return this.renderPageComponent(res, page === 'editor' ? 'page-workflow-editor' : page === 'secrets' ? 'page-secrets' : 'page-workflows', generateWorkflowManagementHtml(page, id, Number.isSafeInteger(revision) && revision > 0 ? revision : undefined));
    }
    if (req.method === 'GET' && url.pathname === '/pages/settings.html') {
      if (!this.requireAdmin(req, res)) return;
      const page = url.searchParams.get('page') === 'notifications' ? 'notifications' : 'tokens';
      return this.renderPageComponent(res, 'page-settings', generateSettingsHtml(page));
    }

    if (req.method === 'GET' && url.pathname === '/workflows') {
      if (!this.requireAdmin(req, res)) return;
      res.writeHead(302, { Location: '/settings/workflows' });
      return res.end();
    }

    if (req.method === 'GET' && url.pathname === '/settings') {
      if (!this.isAdmin(req)) return this.requireAdmin(req, res);
      res.writeHead(302, { Location: '/settings/workflows' });
      return res.end();
    }

    const settingsPageMatch = url.pathname.match(/^\/settings\/(workflows|secrets|tokens|notifications)$/);
    if (req.method === 'GET' && settingsPageMatch) {
      if (!this.requireAdmin(req, res)) return;
      const page = settingsPageMatch[1] as 'workflows' | 'secrets' | 'tokens' | 'notifications';
      return this.renderAppShell(res);
    }

    if (url.pathname === '/api/api-keys') {
      if (!this.isAdmin(req)) return this.requireAdmin(req, res);
      if (req.method === 'GET') return res.end(JSON.stringify({ keys: await this.apiKeys.list() }));
      if (req.method === 'POST') {
        const body = await this.readJson(req, res);
        try {
          const key = await this.apiKeys.issue(body?.name, body?.scopes || []);
          res.writeHead(201, { 'Content-Type': 'application/json; charset=utf-8' });
          return res.end(JSON.stringify(key));
        } catch (error: any) {
          res.writeHead(422, { 'Content-Type': 'application/json' });
          return res.end(JSON.stringify({ error: error.message }));
        }
      }
    }
    const apiKeyMatch = url.pathname.match(/^\/api\/api-keys\/([^/]+)$/);
    if (apiKeyMatch && req.method === 'DELETE') {
      if (!this.isAdmin(req)) return this.requireAdmin(req, res);
      const revoked = await this.apiKeys.revoke(apiKeyMatch[1]);
      res.writeHead(revoked ? 204 : 404).end();
      return;
    }

    const settingsEditorMatch = url.pathname.match(/^\/settings\/workflows\/(new|[a-z0-9-]+)$/);
    if (req.method === 'GET' && settingsEditorMatch) {
      if (!this.requireAdmin(req, res)) return;
      const workflowId = settingsEditorMatch[1] === 'new' ? '' : settingsEditorMatch[1];
      const revisionParam = url.searchParams.get('revision');
      const parsedRevision = revisionParam === null ? undefined : Number(revisionParam);
      const revision = parsedRevision !== undefined && Number.isSafeInteger(parsedRevision) && parsedRevision > 0 ? parsedRevision : undefined;
      return this.renderAppShell(res);
    }

    const workflowEditorMatch = url.pathname.match(/^\/workflows\/(new|[a-z0-9-]+)$/);
    if (req.method === 'GET' && workflowEditorMatch) {
      if (!this.requireAdmin(req, res)) return;
      const workflowId = workflowEditorMatch[1] === 'new' ? '' : workflowEditorMatch[1];
      const target = workflowId ? `/settings/workflows/${workflowId}` : '/settings/workflows/new';
      res.writeHead(302, { Location: `${target}${url.search}` });
      return res.end();
    }

    if (req.method === 'GET' && url.pathname === '/api/jobs') {
      const afterIdParam = url.searchParams.get('afterId');
      const beforeIdParam = url.searchParams.get('beforeId');
      const limitParam = url.searchParams.get('limit');
      const filter = url.searchParams.get('filter')?.trim() || undefined;
      const workflowId = url.searchParams.get('workflowId')?.trim() || undefined;
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
      if (filter && filter.length > 200) {
        res.writeHead(400, { 'Content-Type': 'application/json; charset=utf-8' });
        return res.end(JSON.stringify({ error: 'filter must be at most 200 characters' }));
      }

      return this.renderDashboardJobs(res, limit, afterId, beforeId, filter, workflowId);
    }

    if (req.method === 'GET' && url.pathname === '/api/events') {
      return this.events.subscribe(req, res);
    }

    if (req.method === 'GET' && url.pathname === '/api/push/public-key') return this.handlePushPublicKey(res);
    if (req.method === 'POST' && url.pathname === '/api/push/subscriptions') return this.handlePushSubscribe(req, res);
    if (req.method === 'DELETE' && url.pathname === '/api/push/subscriptions') return this.handlePushUnsubscribe(req, res);

    if (url.pathname === '/api/workflows/validate' && req.method === 'POST') {
      return this.handleWorkflowValidation(req, res);
    }

    if (url.pathname === '/api/secrets' && req.method === 'GET') return this.handleSecretList(req, res);
    const secretMatch = url.pathname.match(/^\/api\/secrets\/([A-Z][A-Z0-9_]*)$/);
    if (secretMatch && req.method === 'PUT') return this.handleSecretSave(req, res, secretMatch[1]);
    if (secretMatch && req.method === 'DELETE') return this.handleSecretDelete(req, res, secretMatch[1]);
    const jobSecretsMatch = url.pathname.match(/^\/api\/jobs\/(\d+)\/secrets$/);
    if (jobSecretsMatch && req.method === 'GET') return this.handleJobSecrets(req, res, jobSecretsMatch[1]);
    const cancelJobMatch = url.pathname.match(/^\/api\/jobs\/(\d+)\/cancel$/);
    if (cancelJobMatch && req.method === 'POST') return this.handleCancelJob(req, res, cancelJobMatch[1]);

    if (url.pathname === '/api/workflows' && req.method === 'GET') {
      return this.handleWorkflowList(req, res);
    }

    const workflowMatch = url.pathname.match(/^\/api\/workflows\/([a-z0-9-]+)(\/publish)?$/);
    if (workflowMatch) {
      const [, workflowId, publish] = workflowMatch;
      if (req.method === 'GET' && !publish) return this.handleWorkflowGet(req, res, workflowId, url.searchParams.get('revision'));
      if (req.method === 'PUT' && !publish) return this.handleWorkflowSave(req, res, workflowId);
      if (req.method === 'DELETE' && !publish) return this.handleWorkflowDelete(req, res, workflowId);
      if (req.method === 'POST' && publish) return this.handleWorkflowPublish(req, res, workflowId);
    }

    if (req.method === 'POST' && url.pathname === '/api/events') {
      return this.handleWorkerEvent(req, res);
    }

    if (req.method === 'GET' && url.pathname.startsWith('/runs/')) {
      const jobId = url.pathname.replace('/runs/', '');
       return this.renderRunDetails(jobId, res, 'html', await this.hasScope(req, 'logs:read'));
    }

    const aiHelpMatch = url.pathname.match(/^\/api\/runs\/(\d+)\/ai-help$/);
    if (req.method === 'POST' && aiHelpMatch) return this.handleAiHelp(req, res, aiHelpMatch[1]);

    if (req.method === 'GET' && url.pathname.startsWith('/api/runs/')) {
      const artifactMatch = url.pathname.match(/^\/api\/runs\/(\d+)\/artifacts\/(.+)$/);
      if (artifactMatch) return this.handleArtifactDownload(req, res, artifactMatch[1], decodeURIComponent(artifactMatch[2]));
      const jobId = url.pathname.replace('/api/runs/', '');
       return this.renderRunDetails(jobId, res, 'json', await this.hasScope(req, 'logs:read'));
    }

    if (req.method === 'POST' && url.pathname.startsWith('/restart/')) {
      const jobId = url.pathname.replace('/restart/', '');
      return this.handleRestartJob(req, jobId, res);
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

       const { isValid, inputs, secretValues } = await this.preprocess(provider, headers, rawBuffer);

      if (!isValid) {
        res.writeHead(401, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Invalid HMAC signature or authentication failed' }));
        return;
      }

      await this.workflowsLoaded;
       await this.matchWorkflows(provider, inputs, await this.workflows.published(), secretValues);

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

  private async preprocess(provider: string, headers, rawBuffer: Buffer) {
    let dbSecrets: Record<string, string> = {};
    try {
      dbSecrets = await this.secretRepository.getAll();
    } catch (error) {
      if (process.env.RUNNER_MASTER_KEY || process.env.CREDENTIALS_DIRECTORY) throw error;
    }
    const secret =
      dbSecrets[`${provider.toUpperCase()}_WEBHOOK_SECRET`] ||
      this.secrets.get(`${provider.toUpperCase()}_WEBHOOK_SECRET`);
    const preprocessor = this.preprocessors.get(provider);
    try {
      if (preprocessor) {
        const result = preprocessor.parse(headers, rawBuffer, secret);
        const { inputs, isValid } = result;
        return { inputs, isValid, secretValues: dbSecrets };
      }

      const inputs = JSON.parse(rawBuffer.toString('utf-8'));
      return { isValid: true, inputs, secretValues: dbSecrets };
    } catch {
      return { isValid: false, inputs: null, secretValues: dbSecrets };
    }
  }

  private async matchWorkflows(provider: string, inputs: any, workflows: import('./types.js').WorkflowRevision[], secretValues: Record<string, string> = {}) {
    for (const { definition: workflow, revision } of workflows) {
      if (workflow.on.provider !== provider) continue;

      const preprocessor = this.preprocessors.get(provider);
      if (preprocessor?.filter && !preprocessor.filter(inputs, workflow.on).isValid) {
        debug(`⏩ Skipped ${workflow.id} based on ${provider} webhook filters`, { inputs });
        continue;
      }

      if (workflow.on.if) {
        try {
          const conditionContext = preprocessor?.conditionContext?.(inputs, secretValues) || {};
          const shouldRun = await SafeExpressionEvaluator.evaluateConditions(workflow.on.if, { inputs, ...conditionContext });

          if (!shouldRun) {
            debug(`⏩ Skipped ${workflow.id} based on conditions: ${workflow.on.if}`, { inputs });
            continue;
          }
        } catch (evalErr: any) {
          console.error(`⚠️ Condition evaluation error in workflow [${workflow.id}]:`, evalErr.message);
          continue; // Skip this workflow without crashing server
        }
      }

      for (const variant of expandMatrix(workflow)) {
        const requiredTags = await resolveMatrixTags(variant.tags, variant.matrixContext, inputs);
        let concurrencyKey = '';
        if (variant.concurrency?.group) {
          concurrencyKey = await SafeExpressionEvaluator.evaluateValue(variant.concurrency.group, { inputs });
        }

        const jobPayload: JobPayload = {
          inputs,
          matrix: variant.matrixContext,
        };

        await this.queue.enqueue(workflow.id, revision, jobPayload, requiredTags, concurrencyKey);
        this.events.publish('jobs.available', { tags: requiredTags });
      }
    }
  }

  private isAdmin(req: http.IncomingMessage): boolean {
    return this.matchesToken(req, this.adminToken, true);
  }

  private isWorker(req: http.IncomingMessage): boolean {
    return this.matchesToken(req, this.workerToken, false);
  }

  private async hasScope(req: http.IncomingMessage, scope: string): Promise<boolean> {
    if (this.isAdmin(req)) return true;
    const authorization = req.headers.authorization || '';
    if (!authorization.startsWith('Bearer ')) return false;
    const scopes = await this.apiKeys.scopesForToken(authorization.slice(7));
    return Boolean(scopes?.includes(scope));
  }

  private async requireScope(req: http.IncomingMessage, res: http.ServerResponse, scope: string): Promise<boolean> {
    if (await this.hasScope(req, scope)) return true;
    res.writeHead(401, { 'Content-Type': 'application/json; charset=utf-8', 'WWW-Authenticate': 'Basic realm="Runner"' });
    res.end(JSON.stringify({ error: `Missing scope: ${scope}` }));
    return false;
  }

  private matchesToken(req: http.IncomingMessage, token: string, allowBasic: boolean): boolean {
    if (!token) return false;
    const auth = req.headers.authorization || '';
    const matches = (value: string) => {
      const expected = Buffer.from(token);
      const received = Buffer.from(value);
      return expected.length === received.length && crypto.timingSafeEqual(expected, received);
    };
    if (auth.startsWith('Bearer ') && matches(auth.slice(7))) return true;
    if (!allowBasic || !auth.startsWith('Basic ')) return false;
    try {
      const decoded = Buffer.from(auth.slice(6), 'base64').toString('utf8');
      const separator = decoded.indexOf(':');
      return separator > 0 && decoded.slice(0, separator) === 'admin' && matches(decoded.slice(separator + 1));
    } catch {
      return false;
    }
  }

  private requireAdmin(req: http.IncomingMessage, res: http.ServerResponse): boolean {
    if (this.isAdmin(req)) return true;
    res.writeHead(401, {
      'Content-Type': 'application/json; charset=utf-8',
      'WWW-Authenticate': 'Basic realm="Runner"',
    });
    res.end(JSON.stringify({ error: 'Unauthorized' }));
    return false;
  }

  private async readJson(req: http.IncomingMessage, res: http.ServerResponse): Promise<any | null> {
    const { rawBuffer } = await this.readRequest(req, res);
    if (!rawBuffer || res.headersSent) return null;
    try {
      return JSON.parse(rawBuffer.toString('utf8'));
    } catch {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Invalid JSON body' }));
      return null;
    }
  }

  private async handleWorkflowValidation(req: http.IncomingMessage, res: http.ServerResponse) {
    if (!(await this.requireScope(req, res, 'workflows:write'))) return;
    const body = await this.readJson(req, res);
    if (!body) return;
    try {
      const workflows = this.workflows.validate(body.sourceYaml);
      res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify({ valid: true, workflows }));
    } catch (error: any) {
      res.writeHead(422, { 'Content-Type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify({ valid: false, error: error.message }));
    }
  }

  private async handleWorkflowList(req: http.IncomingMessage, res: http.ServerResponse) {
    if (!(await this.requireScope(req, res, 'workflows:read'))) return;
    await this.workflowsLoaded;
    res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
    res.end(JSON.stringify({ workflows: await this.workflows.list() }));
  }

  private async handleWorkflowGet(req: http.IncomingMessage, res: http.ServerResponse, id: string, revisionParam: string | null = null) {
    if (!(await this.requireScope(req, res, 'workflows:read'))) return;
    const revision = revisionParam === null ? undefined : Number(revisionParam);
    const workflow = revision !== undefined && Number.isSafeInteger(revision) && revision > 0
      ? await this.workflows.getRevisionSnapshot(id, revision)
      : await this.workflows.get(id);
    if (!workflow) {
      res.writeHead(404, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({ error: 'Workflow not found' }));
    }
    res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
    res.end(JSON.stringify(workflow));
  }

  private async handleWorkflowSave(req: http.IncomingMessage, res: http.ServerResponse, id: string) {
    if (!(await this.requireScope(req, res, 'workflows:write'))) return;
    const body = await this.readJson(req, res);
    if (!body || typeof body.sourceYaml !== 'string') {
      if (!res.headersSent)
        res
          .writeHead(400, { 'Content-Type': 'application/json' })
          .end(JSON.stringify({ error: 'sourceYaml is required' }));
      return;
    }
    try {
      const workflow = await this.workflows.saveDraft(id, body.sourceYaml, body.enabled !== false);
      res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify(workflow));
    } catch (error: any) {
      res.writeHead(422, { 'Content-Type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify({ error: error.message }));
    }
  }

  private async handleWorkflowDelete(req: http.IncomingMessage, res: http.ServerResponse, id: string) {
    if (!(await this.requireScope(req, res, 'workflows:write'))) return;
    if (!(await this.workflows.delete(id))) {
      res.writeHead(404, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({ error: 'Workflow not found' }));
    }
    res.writeHead(204).end();
  }

  private async handleWorkflowPublish(req: http.IncomingMessage, res: http.ServerResponse, id: string) {
    if (!(await this.requireScope(req, res, 'workflows:write'))) return;
    const workflow = await this.workflows.publish(id);
    if (!workflow) {
      res.writeHead(404, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({ error: 'Workflow not found' }));
    }
    res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
    res.end(JSON.stringify(workflow));
  }

  private async handleSecretList(req: http.IncomingMessage, res: http.ServerResponse) {
    if (!this.requireAdmin(req, res)) return;
    res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
    res.end(JSON.stringify({ secrets: await this.secretRepository.names() }));
  }

  private async handleSecretSave(req: http.IncomingMessage, res: http.ServerResponse, name: string) {
    if (!this.requireAdmin(req, res)) return;
    const body = await this.readJson(req, res);
    if (!body || typeof body.value !== 'string') {
      if (!res.headersSent)
        res.writeHead(400, { 'Content-Type': 'application/json' }).end(JSON.stringify({ error: 'value is required' }));
      return;
    }
    try {
      await this.secretRepository.set(name, body.value, body.encoding || 'utf8');
      res.writeHead(204).end();
    } catch (error: any) {
      res.writeHead(422, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: error.message }));
    }
  }

  private async handleSecretDelete(req: http.IncomingMessage, res: http.ServerResponse, name: string) {
    if (!this.requireAdmin(req, res)) return;
    if (!(await this.secretRepository.delete(name))) {
      res.writeHead(404, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({ error: 'Secret not found' }));
    }
    res.writeHead(204).end();
  }

  private async handleJobSecrets(req: http.IncomingMessage, res: http.ServerResponse, jobId: string) {
    if (!this.isWorker(req)) {
      res.writeHead(403, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({ error: 'Unauthorized' }));
    }
    const job = await this.queue.getJob(jobId);
    if (!job || job.status !== 'running' || job.worker_id !== req.headers['x-runner-worker-id']) {
      res.writeHead(403, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({ error: 'Job is not assigned to this worker' }));
    }
    res.writeHead(200, { 'Cache-Control': 'no-store', 'Content-Type': 'application/json; charset=utf-8' });
    res.end(JSON.stringify({ secrets: await this.secretRepository.getAllForJob() }));
  }

  /**
   * Handles Zero-Downtime Secret Reload
   */
  private async handleSecretReload(req: http.IncomingMessage, res: http.ServerResponse) {
    if (!this.isAdmin(req)) {
      res.writeHead(403, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({ error: 'Unauthorized' }));
    }

    // Trigger in-memory secret reload
    this.secrets.reload();
    console.log('🔄 SecretStore reloaded successfully without downtime!');

    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ message: 'Secrets reloaded successfully' }));
  }

  private async handleWorkerEvent(req: http.IncomingMessage, res: http.ServerResponse) {
    if (!this.isWorker(req)) {
      res.writeHead(403, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({ error: 'Unauthorized' }));
    }

    const { rawBuffer } = await this.readRequest(req, res);
    if (!rawBuffer || res.headersSent) return;

    let jobId: number | undefined;
    try {
      const payload = rawBuffer.length ? JSON.parse(rawBuffer.toString('utf8')) : {};
      const parsedJobId = Number(payload.jobId);
      if (Number.isSafeInteger(parsedJobId) && parsedJobId > 0) jobId = parsedJobId;
    } catch {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({ error: 'Invalid event payload' }));
    }

    this.events.publish('jobs.changed', jobId ? { jobId } : {});
    if (jobId) {
      const job = await this.queue.getJob(jobId);
      if (job) void this.push.notify(job);
    }
    res.writeHead(202).end();
  }

  private handlePushPublicKey(res: http.ServerResponse) {
    if (!this.push.publicKey) {
      res.writeHead(404, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({ error: 'Push notifications are not configured' }));
    }
    res.writeHead(200, { 'Cache-Control': 'public, max-age=3600', 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ publicKey: this.push.publicKey }));
  }

  private async handlePushSubscribe(req: http.IncomingMessage, res: http.ServerResponse) {
    const body = await this.readJson(req, res);
    if (!body) return;
    if (!this.push.publicKey || typeof body.endpoint !== 'string' || !body.keys || typeof body.keys.p256dh !== 'string' || typeof body.keys.auth !== 'string') {
      if (!res.headersSent) res.writeHead(400, { 'Content-Type': 'application/json' }).end(JSON.stringify({ error: 'Invalid push subscription' }));
      return;
    }
    await this.push.save(body);
    res.writeHead(204).end();
  }

  private async handlePushUnsubscribe(req: http.IncomingMessage, res: http.ServerResponse) {
    const body = await this.readJson(req, res);
    if (!body) return;
    if (typeof body.endpoint !== 'string') {
      if (!res.headersSent) res.writeHead(400, { 'Content-Type': 'application/json' }).end(JSON.stringify({ error: 'endpoint is required' }));
      return;
    }
    await this.push.remove(body.endpoint);
    res.writeHead(204).end();
  }

  /**
   * Serves the Server Health & Jobs Dashboard
   */
  private async renderDashboard(res: http.ServerResponse) {
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    res.end(generateDashboardHtml());
  }

  private renderAppShell(res: http.ServerResponse) {
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' });
    return res.end(appShellTemplate);
  }

  private renderPageComponent(res: http.ServerResponse, name: string, source: string, body = false) {
    const styles = Array.from(source.matchAll(/<style[\s\S]*?<\/style>/gi)).map((match) => match[0]).join('');
    let content = source;
    if (body) {
      content = source.match(/<body[^>]*>([\s\S]*?)<\/body>/i)?.[1] || source;
    } else {
      const start = source.indexOf('<template app>');
      const end = source.lastIndexOf('</template>');
      if (start !== -1 && end > start) content = source.slice(start + '<template app>'.length, end);
    }
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' });
    return res.end(`<template component="${name}">${styles}${content}</template>`);
  }

  private async renderDashboardJobs(
    res: http.ServerResponse,
    limit: number,
    afterId?: number,
    beforeId?: number,
    filter?: string,
    workflowId?: string,
  ) {
    let rows;
    try {
      rows = await this.queue.listJobs(limit + 1, afterId, beforeId, filter, workflowId);
    } catch (error: any) {
      res.writeHead(400, { 'Content-Type': 'application/json; charset=utf-8' });
      return res.end(JSON.stringify({ error: error.message }));
    }
    const jobs = toDashboardJobs(rows.slice(0, limit));
    const body = await this.redactText(JSON.stringify({ jobs, hasMore: rows.length > limit }));
    res.writeHead(200, {
      'Cache-Control': 'no-store',
      'Content-Type': 'application/json; charset=utf-8',
    });
    res.end(body);
  }

  /**
   * Serves single job HTML report
   */
  private async renderRunDetails(jobId: string, res: http.ServerResponse, format: 'html' | 'json', canViewLogs: boolean) {
    const job = await this.queue.getJob(jobId);

    if (!job) {
      const contentType = format === 'json' ? 'application/json; charset=utf-8' : 'text/html; charset=utf-8';
      res.writeHead(404, { 'Content-Type': contentType });
      return res.end(format === 'json' ? JSON.stringify({ error: 'Run not found' }) : '<h1>404 - Run Not Found</h1>');
    }

    const logsMap = canViewLogs ? await this.queue.getJobLogs(jobId) : {};
    const secretValues = await this.currentSecrets();
    const definition = await this.workflows.getRevision(job.workflow_id, job.workflow_revision);
    const snapshot = canViewLogs ? await this.workflows.getRevisionSnapshot(job.workflow_id, job.workflow_revision) : null;
    const report = buildRunView(
      job,
      logsMap,
      (value) => this.redact(value, secretValues),
      definition?.steps,
      canViewLogs,
      snapshot?.sourceYaml,
    );

    if (format === 'json') {
      res.writeHead(200, { 'Cache-Control': 'no-store', 'Content-Type': 'application/json; charset=utf-8' });
      return res.end(JSON.stringify(report));
    }

    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    res.end(renderRunHtml(report));
  }

  private async handleRestartJob(req: http.IncomingMessage, jobId: string, res: http.ServerResponse) {
    if (!(await this.requireScope(req, res, 'runs:control'))) return;
    const id = await this.queue.restartJob(jobId);

    if (id) {
      this.events.publish('jobs.available');
      res.writeHead(201, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ id }));
      return;
    }

    res.writeHead(404, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'Job not found' }));
  }

  private async handleArtifactDownload(req: http.IncomingMessage, res: http.ServerResponse, jobId: string, filePath: string) {
    if (!(await this.requireScope(req, res, 'artifacts:read'))) return;
    const file = (await this.queue.getStoredFiles('artifact', jobId)).find((entry) => entry.path === filePath);
    if (!file) {
      res.writeHead(404, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({ error: 'Artifact not found' }));
    }
    res.writeHead(200, {
      'Cache-Control': 'no-store',
      'Content-Type': 'application/octet-stream',
      'Content-Disposition': `attachment; filename="${filePath.replace(/[^a-zA-Z0-9._-]/g, '_')}"`,
    });
    return res.end(Buffer.from(file.content, 'base64'));
  }

  private async handleAiHelp(req: http.IncomingMessage, res: http.ServerResponse, jobId: string) {
    if (!(await this.hasScope(req, 'logs:read'))) return this.requireScope(req, res, 'logs:read');
    const apiKey = await this.currentSecrets().then((secrets) => secrets.OPENAI_API_KEY || process.env.OPENAI_API_KEY);
    const model = process.env.OPENAI_API_MODEL;
    const apiUrl = process.env.OPENAI_API_URL;
    if (!model || !apiUrl) {
      res.writeHead(503, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({ error: 'AI help is not configured' }));
    }
    const job = await this.queue.getJob(jobId);
    if (!job?.report) {
      res.writeHead(404, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({ error: 'Run report not found' }));
    }
    const body = await this.readJson(req, res);
    const failedStepId = typeof body?.stepId === 'string' ? body.stepId : '';
    const question = typeof body?.question === 'string' && body.question.trim() ? body.question.trim() : undefined;
    const conversation = Array.isArray(body?.conversation)
      ? body.conversation.filter((message: any) => (message?.role === 'user' || message?.role === 'assistant') && typeof message.content === 'string').slice(-20)
      : [];
    const report = JSON.parse(job.report);
    const snapshot = await this.workflows.getRevisionSnapshot(job.workflow_id, job.workflow_revision);
    if (!snapshot || !failedStepId) {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({ error: 'A failed step and workflow revision are required' }));
    }
    const secretValues = await this.currentSecrets();
    const messages = buildAiHelpMessages(
      snapshot.sourceYaml,
      report.steps || [],
      await this.queue.getJobLogs(jobId),
      failedStepId,
      (value) => this.redact(value, secretValues),
      question,
      conversation,
    );
    try {
      const requestBody = createAiRequest(model, messages);
      const workflowUrl = new URL(`/runs/${jobId}`, `${req.headers['x-forwarded-proto'] || 'http'}://${req.headers['x-forwarded-host'] || req.headers.host}`).toString();
      await this.queue.saveAiRequest(jobId, workflowUrl, requestBody);
      res.writeHead(200, { 'Cache-Control': 'no-store', 'Content-Type': 'text/event-stream', Connection: 'keep-alive' });
      await streamAiHelp(apiUrl, apiKey, requestBody, (delta) => res.write(`data: ${JSON.stringify({ delta })}\n\n`));
      res.write('data: {"done":true}\n\n');
      return res.end();
    } catch (error: any) {
      if (res.headersSent) {
        res.write(`data: ${JSON.stringify({ error: error.message })}\n\n`);
        return res.end();
      }
      res.writeHead(502, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({ error: error.message }));
    }
  }

  private async handleCancelJob(req: http.IncomingMessage, res: http.ServerResponse, jobId: string) {
    if (!(await this.requireScope(req, res, 'runs:control'))) return;

    const result = await this.queue.cancelJob(jobId);
    if (result === 'not_found') {
      res.writeHead(404, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({ error: 'Job not found' }));
    }
    if (result === 'not_active') {
      res.writeHead(409, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({ error: 'Job is no longer running' }));
    }

    this.events.publish('jobs.changed', { jobId: Number(jobId) });
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ id: Number(jobId), status: 'cancelled' }));
  }

  private async currentSecrets(): Promise<Record<string, string>> {
    try {
      return await this.secretRepository.getAll();
    } catch (error) {
      if (process.env.RUNNER_MASTER_KEY || process.env.CREDENTIALS_DIRECTORY) throw error;
      return this.secrets.getAll();
    }
  }

  private redact(value: string, secrets: Record<string, string>): string {
    const redactor = new SecretStore();
    redactor.replace(secrets);
    return redactor.redactText(value);
  }

  private async redactText(value: string): Promise<string> {
    return this.redact(value, await this.currentSecrets());
  }

  async listen(port: number): Promise<WebhookServer> {
    await this.workflowsLoaded;
    return new Promise((resolve) => {
      this.server.listen(port, process.env.RUNNER_HOST || '0.0.0.0', () => {
        console.log(`🌐 Webhook Ingress Server running on port ${port}`);
        resolve(this);
      });
    });
  }

  async stop(): Promise<void> {
    this.events.close();
    return new Promise((resolve) => {
      this.server.close(() => {
        console.log('🌐 Webhook Ingress Server stopped listening.');
        resolve();
      });
    });
  }
}
