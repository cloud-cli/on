import { createServer } from 'node:http';
import { loadConfig } from './config.js';
import type { ServerOptions, WorkflowEvent } from './types.js';
import { sendJson, asObject } from './utils.js';
import { processEvent } from './workflow.js';
import { spawn } from 'node:child_process';
import { formatReportAsHTML, getReport } from './reports.js';
import preprocessors from './event-preprocess.js';
import { randomUUID } from 'node:crypto';

export async function startDaemon(options: ServerOptions): Promise<ReturnType<typeof createServer> | null> {
  if (options.daemon) {
    const skipDaemon = process.argv.slice(1).filter((arg) => arg !== '--daemon' && arg !== '-d');
    const args = process.execArgv.concat(skipDaemon);
    const child = spawn(process.execPath, args, {
      detached: true,
      stdio: 'ignore',
    });

    console.log(child.pid);
    child.unref();
    return null;
  }

  const config = await loadConfig(options.configPath);
  const server = createServer(async (request, response) => {
    response.on('finish', () => {
      console.log(`[${new Date().toISOString().slice(0, 19)}] ${response.statusCode} ${request.method} ${request.url}`);
    });

    const url = new URL(String(request.url), request.headers['x-forwarded-host'] || 'http://localhost');

    if (request.method === 'GET' && url.pathname === '/health') {
      sendJson(response, 200, { status: 'OK' });
      return;
    }

    if (request.method === 'GET' && url.pathname.startsWith('/reports/')) {
      const id = url.pathname.split('/reports/')[1];
      const report = await getReport(id);
      response.writeHead(report ? 200 : 404, { 'Content-Type': 'text/html' });
      response.end(await formatReportAsHTML(report));
      return;
    }

    if (request.method !== 'POST') {
      sendJson(response, 405, { error: 'Only POST webhooks are supported.' });
      return;
    }

    try {
      let event: WorkflowEvent | null;
      const source = url.pathname.slice(1);
      const body = Buffer.concat(await request.toArray()).toString();

      if (source in preprocessors) {
        event = preprocessors[source as keyof typeof preprocessors](request, body);
      } else {
        event = {
          source,
          event: asObject<WorkflowEvent['event']>(JSON.parse(body || '{}')),
        };
      }

      if (!event) {
        response.writeHead(400);
        response.end('No events matched this request');
        return;
      }

      const logUrl = (id: string) => new URL('/reports/' + id, url);
      const id = randomUUID();
      event.id = id;

      sendJson(response, 202, { results_url: logUrl(id) });

      const outputs = await processEvent(event, config);

      if (outputs) {
        console.log({
          id: outputs.id,
          logUrl: logUrl(outputs.id).href,
          parent: !outputs.parentId
            ? null
            : {
                id: outputs.parentId,
                logUrl: outputs.parentId ? logUrl(outputs.parentId).href : undefined,
              },
          children:
            outputs.children?.map((childId) => ({
              id: childId,
              logUrl: logUrl(childId).href,
            })) || [],
        });
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Unknown error';
      console.error('Error processing webhook:', error);
      if (!response.headersSent) {
        sendJson(response, 400, { error: message });
      }
    }
  });

  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(options.port, options.host, () => resolve());
  });

  const address = server.address();
  if (address && typeof address === 'object') {
    console.log(`Started on http://${address.address}:${address.port}`);
  }

  return server;
}
