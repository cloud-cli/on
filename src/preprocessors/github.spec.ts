import crypto from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { GitHubPreprocessor } from './github.js';

const preprocessor = new GitHubPreprocessor();
const inputs = {
  event: 'push',
  owner: 'octocat',
  repo: 'example',
  branch: 'releases/1.0',
  tag: '',
  ref: 'releases/1.0',
  full_name: 'octocat/example',
  changes: ['src/index.ts', 'package-lock.json'],
};

describe('GitHubPreprocessor filters', () => {
  it('requires every configured field and allows any value within a field', () => {
    const result = preprocessor.filter(inputs, {
      provider: 'github',
      events: ['push'],
      owner: 'octocat',
      repo: ['another-example', 'example'],
      branches: ['main', 'releases/*'],
      paths: ['package*.json'],
      if: 'false',
    });

    expect(result.isValid).toBe(true);
  });

  it.each([
    ['events', { events: ['pull_request'] }],
    ['owner', { owner: 'other' }],
    ['repo', { repo: ['other'] }],
    ['branches', { branches: ['main'] }],
    ['paths', { paths: ['docs/*'] }],
  ])('rejects a non-matching %s filter', (_name, trigger) => {
    expect(preprocessor.filter(inputs, { provider: 'github', ...trigger }).isValid).toBe(false);
  });

  it('matches branches and refs against both branch and tag names', () => {
    const tagInputs = { ...inputs, branch: '', tag: 'v1.4.0', ref: 'v1.4.0' };

    expect(preprocessor.filter(inputs, { provider: 'github', branches: 'releases/*' }).isValid).toBe(true);
    expect(preprocessor.filter(tagInputs, { provider: 'github', branches: 'v1.*' }).isValid).toBe(true);
    expect(preprocessor.filter(tagInputs, { provider: 'github', refs: 'v1.*' }).isValid).toBe(true);
    expect(preprocessor.filter(tagInputs, { provider: 'github', refs: 'main' }).isValid).toBe(false);
    expect(preprocessor.filter(inputs, { provider: 'github', tag: true }).isValid).toBe(false);
  });

  it('matches full repository names and excludes negated values', () => {
    expect(preprocessor.filter(inputs, { provider: 'github', name: 'octocat/example' }).isValid).toBe(true);
    expect(preprocessor.filter(inputs, { provider: 'github', name: '!octocat/example' }).isValid).toBe(false);
    expect(preprocessor.filter(inputs, { provider: 'github', name: '!octocat/other' }).isValid).toBe(true);
    expect(preprocessor.filter(inputs, { provider: 'github', owner: ['octocat', '!octocat'] }).isValid).toBe(false);
    expect(preprocessor.filter(inputs, { provider: 'github', repo: ['!other', '!another-example'] }).isValid).toBe(true);
  });
});

describe('GitHubPreprocessor parsing', () => {
  it('normalizes signed pushes and safely combines changed paths', () => {
    const secret = 'secret';
    const body = Buffer.from(
      JSON.stringify({
        ref: 'refs/heads/main',
        repository: { full_name: 'octocat/example' },
        commits: [{ added: ['new.ts'], modified: ['changed.ts'] }, { removed: ['old.ts'] }],
      }),
    );
    const signature = 'sha256=' + crypto.createHmac('sha256', secret).update(body).digest('hex');
    const result = preprocessor.parse(
      { 'x-github-event': 'push', 'x-hub-signature-256': signature },
      body,
      secret,
    );

    expect(result.isValid).toBe(true);
    expect(result.inputs).toMatchObject({
      event: 'push',
      owner: 'octocat',
      repo: 'example',
      branch: 'main',
      tag: '',
      ref: 'main',
      full_name: 'octocat/example',
      changes: ['new.ts', 'changed.ts', 'old.ts'],
    });
  });

  it('rejects requests without a signature', () => {
    expect(preprocessor.parse({}, Buffer.from('{}'), 'secret').isValid).toBe(false);
  });

  it('uses the head commit from pull request payloads', () => {
    const secret = 'secret';
    const body = Buffer.from(
      JSON.stringify({
        repository: { full_name: 'octocat/example' },
        pull_request: { head: { sha: 'pull-request-sha' } },
      }),
    );
    const signature = 'sha256=' + crypto.createHmac('sha256', secret).update(body).digest('hex');
    const result = preprocessor.parse(
      { 'x-github-event': 'pull_request', 'x-hub-signature-256': signature },
      body,
      secret,
    );

    expect(result.inputs.commit_sha).toBe('pull-request-sha');
  });
});
