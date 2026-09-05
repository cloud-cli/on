import crypto from 'node:crypto';
import type { PreprocessedWebhook, WebhookPreprocessor, WorkflowTrigger } from '../types.js';

function matchesGlob(value: string, pattern: string): boolean {
  const expression = pattern.replace(/[|\\{}()[\]^$+?.]/g, '\\$&').replace(/\*/g, '.*');
  return new RegExp(`^${expression}$`).test(value);
}

function matchesValue(value: string, expected: string | string[]): boolean {
  const values = Array.isArray(expected) ? expected : [expected];

  return values.some((v) => {
    if (v.at(0) === '!') {
      return v.slice(1) !== value;
    }

    return v === value;
  });
}

interface GithubWorkflowTrigger extends WorkflowTrigger {
  events?: string[];
  owner?: string | string[];
  repo?: string | string[];
  branches?: string[];
  tag?: boolean;
  tags?: string[];
  paths?: string[];
}

export class GitHubPreprocessor implements WebhookPreprocessor {
  name = 'github';

  parse(headers: Record<string, string>, rawBodyBuffer: Buffer, secret?: string): PreprocessedWebhook {
    let isValid = false;
    let inputs: any = null;
    const signature = headers['x-hub-signature-256'];

    if (secret && signature) {
      const hmac = 'sha256=' + crypto.createHmac('sha256', secret).update(rawBodyBuffer).digest('hex');
      const signatureBuffer = Buffer.from(signature);
      const hmacBuffer = Buffer.from(hmac);
      isValid = signatureBuffer.length === hmacBuffer.length && crypto.timingSafeEqual(signatureBuffer, hmacBuffer);
    }

    if (isValid) {
      const body = JSON.parse(rawBodyBuffer.toString('utf-8'));
      const event = headers['x-github-event'] || 'unknown';
      const ref = body.ref || '';
      const branch = !ref.includes('refs/heads') ? '' : ref.replace('refs/heads/', '');
      const tag = !ref.includes('refs/tags') ? '' : ref.replace('refs/tags/', '');
      const [owner, repo] = (body.repository?.full_name || '').split('/');

      const commits = body.commits || (body.head_commit ? [body.head_commit] : []);

      inputs = {
        event,
        branch,
        tag,
        owner,
        repo,
        clone_url: body.repository?.clone_url,
        commit_sha: body.after || body.head_commit?.id || body.pull_request?.head?.sha,
        author: body.pusher?.name || body.sender?.login,
        action: body.action,
        raw: body,
        changes: Array.from(
          new Set(
            commits.flatMap((commit) => [
              ...(commit.added || []),
              ...(commit.removed || []),
              ...(commit.modified || []),
            ]),
          ),
        ),
      };
    }

    return {
      isValid,
      inputs,
    };
  }

  filter(inputs: Record<string, any>, trigger: GithubWorkflowTrigger): PreprocessedWebhook {
    let isValid = true;

    if (trigger.events && !trigger.events.includes(inputs.event)) isValid = false;
    if (trigger.owner && !matchesValue(inputs.owner, trigger.owner)) isValid = false;
    if (trigger.repo && !matchesValue(inputs.repo, trigger.repo)) isValid = false;
    if (trigger.branches && !trigger.branches.some((pattern) => matchesGlob(inputs.branch, pattern))) isValid = false;
    if (trigger.tag !== undefined && Boolean(inputs.tag) !== trigger.tag) isValid = false;

    if (trigger.tags) {
      try {
        if (!trigger.tags.some((pattern) => new RegExp(pattern).test(inputs.tag))) isValid = false;
      } catch {
        isValid = false;
      }
    }

    if (trigger.paths) {
      const changes = Array.isArray(inputs.changes) ? inputs.changes : [];
      if (!changes.some((path) => trigger.paths?.some((pattern) => matchesGlob(path, pattern)))) isValid = false;
    }

    return { isValid, inputs };
  }
}
