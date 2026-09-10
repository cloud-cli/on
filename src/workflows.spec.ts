import { describe, expect, it } from 'vitest';
import { parseWorkflow } from './workflows.js';

describe('parseWorkflow', () => {
  it('keeps webhook and time triggers in a portable DB workflow', () => {
    const [workflow] = parseWorkflow(`
name: Nightly build
on:
  github:
    events: [push]
  schedule:
    - id: nightly
      cron: '0 2 * * *'
      timezone: UTC
  solar:
    - event: sunrise
      latitude: 52.52
      longitude: 13.405
steps:
  - run: true
`);

    expect(workflow.id).toBe('nightly-build');
    expect(workflow.on.provider).toBe('github');
    expect(workflow.schedule?.[0].cron).toBe('0 2 * * *');
    expect(workflow.solar?.[0].event).toBe('sunrise');
  });

  it('rejects workflow includes', () => {
    expect(() => parseWorkflow('name: Invalid\nincludes: [base.yml]\non: {generic: {}}\nsteps: [{run: true}]')).toThrow('includes');
  });

  it('defaults step timeouts and retries', () => {
    const [workflow] = parseWorkflow(`
name: Defaults
on: { generic: {} }
steps:
  - run: 'true'
`);

    expect(workflow.retries).toBe(0);
    expect(workflow.steps[0].timeoutMs).toBe(30_000);
  });

  it('normalizes Docker volume and argument options', () => {
    const [workflow] = parseWorkflow(`
name: Container
on: { generic: {} }
steps:
  - image: alpine:latest
    run: 'true'
    volumes: secrets-store:/secrets
    dockerArgs: ['--network=host']
`);

    expect(workflow.steps[0].volumes).toEqual(['secrets-store:/secrets']);
    expect(workflow.steps[0].dockerArgs).toEqual(['--network=host']);
  });

  it('normalizes artifact and cache storage settings', () => {
    const [workflow] = parseWorkflow(`
name: Stored files
on: { generic: {} }
artifacts:
  paths: [dist]
cache:
  key: cache-\${inputs.branch}
  paths: [node_modules]
steps:
  - run: 'true'
`);

    expect(workflow.artifacts).toEqual({ paths: ['dist'] });
    expect(workflow.cache).toEqual({ key: 'cache-${inputs.branch}', paths: ['node_modules'] });
  });

  it('preserves secret file mappings', () => {
    const [workflow] = parseWorkflow(`
name: Signing
on: { generic: {} }
secretFiles:
  .config/signing.key: SIGNING_KEY
steps:
  - run: 'true'
`);

    expect(workflow.secretFiles).toEqual({ '.config/signing.key': 'SIGNING_KEY' });
  });

  it('preserves generic workflow plugin settings', () => {
    const [workflow] = parseWorkflow(`
name: GitHub status
on: { github: { events: [push] } }
plugins:
  - name: github-status
    secrets:
      GITHUB_TOKEN: \${secrets.GITHUB_TOKEN}
    context: ci/build
steps:
  - run: 'true'
`);

    expect(workflow.plugins).toEqual([{ name: 'github-status', secrets: { GITHUB_TOKEN: '${secrets.GITHUB_TOKEN}' }, context: 'ci/build' }]);
  });

  it('preserves matrix definitions for trigger-time expansion', () => {
    const [workflow] = parseWorkflow(`
name: Matrix build
matrix:
  node: [18, 20]
on: { generic: {} }
steps:
  - run: 'node --version'
`);

    expect(workflow.matrix).toEqual({ node: [18, 20] });
  });

  it('keeps an explicit identity separate from the display name', () => {
    const [workflow] = parseWorkflow(`
id: release-pipeline
name: Release pipeline
on: { generic: {} }
steps:
  - run: 'true'
`);

    expect(workflow.id).toBe('release-pipeline');
    expect(workflow.name).toBe('Release pipeline');
  });

  it('validates retry and timeout settings', () => {
    expect(() => parseWorkflow(`name: Invalid\non: { generic: {} }\nretries: -1\nsteps: [{run: 'true'}]`)).toThrow(
      'retries must be a non-negative integer',
    );
    expect(() => parseWorkflow(`name: Invalid\non: { generic: {} }\nsteps: [{run: 'true', timeoutMs: 0}]`)).toThrow(
      'step.timeoutMs must be a positive integer',
    );
  });
});
