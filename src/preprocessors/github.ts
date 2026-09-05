import crypto from 'node:crypto';
import type { PreprocessedWebhook, WebhookPreprocessor, WorkflowTrigger } from '../types.js';

function matchesGlob(value: string, pattern: string): boolean {
  const expression = pattern.replace(/[|\\{}()[\]^$+?.]/g, '\\$&').replace(/\*/g, '.*');
  return new RegExp(`^${expression}$`).test(value);
}

const toArray = (v: any) => (Array.isArray(v) ? v : [v]);

function matchesValue(value: string, expected: string | string[]): boolean {
  const values = toArray(expected);
  const included = values.filter((pattern) => !pattern.startsWith('!'));

  return (
    !values.some((pattern) => pattern.startsWith('!') && pattern.slice(1) === value) &&
    (included.length === 0 || included.includes(value))
  );
}

interface GithubWorkflowTrigger extends WorkflowTrigger {
  events?: string[];
  owner?: string | string[];
  repo?: string | string[];
  name?: string | string[];
  branches?: string | string[];
  refs?: string | string[];
  tag?: boolean;
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
        ref: branch || tag,
        full_name: body.repository?.full_name,
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
    if (trigger.name && !matchesValue(inputs.full_name, trigger.name)) isValid = false;

    if (
      trigger.branches &&
      inputs.ref &&
      !toArray(trigger.branches).some((pattern) => matchesGlob(inputs.ref, String(pattern)))
    )
      isValid = false;

    if (
      trigger.refs &&
      inputs.ref &&
      !toArray(trigger.refs).some((pattern) => matchesGlob(inputs.ref, String(pattern)))
    )
      isValid = false;

    if (trigger.tag !== undefined && Boolean(inputs.tag) !== trigger.tag) isValid = false;

    if (trigger.paths) {
      const changes = Array.isArray(inputs.changes) ? inputs.changes : [];
      if (!changes.some((path) => trigger.paths?.some((pattern) => matchesGlob(path, pattern)))) isValid = false;
    }

    return { isValid, inputs };
  }
}
