import crypto from 'node:crypto';

export interface PreprocessedWebhook {
  isValid: boolean;
  event: string;
  inputs: Record<string, any>;
  rawBody: any;
}

export interface WebhookPreprocessor {
  name: string;
  parse(headers: Record<string, string>, body: any, rawBodyBuffer: Buffer, secret?: string): PreprocessedWebhook;
}

export class GitHubPreprocessor implements WebhookPreprocessor {
  name = 'github';

  parse(headers: Record<string, string>, body: any, rawBodyBuffer: Buffer, secret?: string): PreprocessedWebhook {
    // 1. HMAC Signature Verification
    let isValid = true;
    const signature = headers['x-hub-signature-256'];

    if (secret && signature) {
      const hmac = 'sha256=' + crypto.createHmac('sha256', secret).update(rawBodyBuffer).digest('hex');
      isValid = crypto.timingSafeEqual(Buffer.from(signature), Buffer.from(hmac));
    }

    // 2. Normalize GitHub Event & Headers
    const event = headers['x-github-event'] || 'unknown';
    const ref = body.ref || '';
    const branch = ref.replace('refs/heads/', '').replace('refs/tags/', '');

    return {
      isValid,
      event,
      inputs: {
        event,
        branch,
        clone_url: body.repository?.clone_url,
        commit_sha: body.after || body.head_commit?.id,
        author: body.pusher?.name || body.sender?.login,
        action: body.action // e.g., 'opened', 'synchronize' for PRs
      },
      rawBody: body
    };
  }
}