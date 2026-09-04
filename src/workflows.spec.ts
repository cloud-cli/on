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

  it('rejects filesystem includes', () => {
    expect(() => parseWorkflow('name: Invalid\nincludes: [base.yml]\non: {generic: {}}\nsteps: [{run: true}]')).toThrow('includes');
  });
});
