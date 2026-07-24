import type { IncomingMessage } from 'node:http';
import type { WorkflowEvent } from './types.js';
import { createHmac } from 'node:crypto';

function github(request: IncomingMessage, body: string): WorkflowEvent | null {
  const secret = process.env.WEBHOOKS_GITHUB_SECRET || '';
  const eventSource = request.headers['x-github-event'];
  const requestSignature = request.headers['x-hub-signature'];
  const payloadSignature = 'sha1=' + createHmac('sha1', secret).update(body).digest('hex');

  if (payloadSignature !== requestSignature) {
    return null;
  }

  const json = JSON.parse(body);
  const event = { source: 'github.' + (eventSource || json.action), event: json };
  console.log('GITHUB', event);
  return event;
}

export default { github };
