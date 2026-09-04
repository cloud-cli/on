import crypto from 'node:crypto';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { WorkflowIncludeResolver } from '../parser/include-resolver.js';
import { YamlLoader } from '../parser/yaml-loader.js';
import { GitHubPreprocessor } from './github.js';

const preprocessor = new GitHubPreprocessor();
const inputs = {
  event: 'push',
  owner: 'octocat',
  repo: 'example',
  branch: 'releases/1.0',
  tag: '',
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

  it('filters tag pushes by presence and regular expression', () => {
    const tagInputs = { ...inputs, branch: '', tag: 'v1.4.0' };

    expect(
      preprocessor.filter(tagInputs, { provider: 'github', tag: true, tags: ['^v1\\..*'] }).isValid,
    ).toBe(true);
    expect(preprocessor.filter(tagInputs, { provider: 'github', tags: ['^v2\\..*'] }).isValid).toBe(false);
    expect(preprocessor.filter(tagInputs, { provider: 'github', tags: ['['] }).isValid).toBe(false);
    expect(preprocessor.filter(inputs, { provider: 'github', tag: true }).isValid).toBe(false);
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

describe('YamlLoader trigger filters', () => {
  const directories: string[] = [];

  afterEach(() => {
    for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true });
  });

  it('retains provider-specific filters alongside if', () => {
    const directory = mkdtempSync(join(tmpdir(), 'on-workflow-'));
    directories.push(directory);
    const file = join(directory, 'workflow.yml');
    writeFileSync(
      file,
      `name: Filtered\non:\n  github:\n    events: [push]\n    owner: octocat\n    repo: [example]\n    paths: [package*.json]\n    if: inputs.action === 'published'\nsteps:\n  - run: 'true'\n`,
    );

    const [workflow] = YamlLoader.loadFile(file, new WorkflowIncludeResolver(directory));

    expect(workflow.on).toEqual({
      provider: 'github',
      events: ['push'],
      owner: 'octocat',
      repo: ['example'],
      paths: ['package*.json'],
      if: "inputs.action === 'published'",
    });
  });
});
