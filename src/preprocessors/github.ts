import crypto from 'node:crypto';
import type { PreprocessedWebhook, WebhookPreprocessor } from '../types.js';

export class GitHubPreprocessor implements WebhookPreprocessor {
  name = 'github';

  parse(headers: Record<string, string>, rawBodyBuffer: Buffer, secret?: string): PreprocessedWebhook {
    let isValid = true;
    let inputs: any = null;
    const signature = headers['x-hub-signature-256'];

    if (!secret) {
      isValid = false;
    }

    if (secret && signature) {
      const hmac = 'sha256=' + crypto.createHmac('sha256', secret).update(rawBodyBuffer).digest('hex');
      isValid = crypto.timingSafeEqual(Buffer.from(signature), Buffer.from(hmac));
    }

    if (isValid) {
      const body = JSON.parse(rawBodyBuffer.toString('utf-8'));
      const event = headers['x-github-event'] || 'unknown';
      const ref = body.ref || '';
      const branch = ref.replace('refs/heads/', '').replace('refs/tags/', '');
      const [owner, repo] = (body.repository?.full_name || '').split('/');

      inputs = {
        event,
        branch,
        owner,
        repo,
        clone_url: body.repository?.clone_url,
        commit_sha: body.after || body.head_commit?.id,
        author: body.pusher?.name || body.sender?.login,
        action: body.action,
        raw: body,
      };
    }

    return {
      isValid,
      inputs,
    };
  }
}
