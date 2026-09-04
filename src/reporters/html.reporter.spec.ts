import { describe, expect, it } from 'vitest';
import { WorkflowExecutionReport } from '../types.js';
import { HtmlReporter } from './html.reporter.js';

const reporter = new HtmlReporter({ outputDir: '' });

function report(status: WorkflowExecutionReport['status']): WorkflowExecutionReport {
  return {
    jobId: '42',
    parentId: '',
    workflowName: 'deploy',
    status,
    durationMs: 250,
    startedAt: '2026-09-04T00:00:00.000Z',
    inputs: {},
    environment: {},
    steps: [
      {
        id: 'build',
        name: 'Build',
        status: 'success',
        durationMs: 100,
        exitCode: 0,
        outputs: { artifact: 'app.tar' },
        logContent: 'build complete',
      },
      {
        id: 'deploy',
        name: 'Deploy',
        status: 'running',
        durationMs: 0,
        outputs: {},
        logContent: '',
      },
      {
        id: 'notify',
        name: 'Notify',
        status: 'pending',
        durationMs: 0,
        outputs: {},
        logContent: '',
      },
    ],
    artifacts: [],
    rerunToken: '{}',
  };
}

describe('HtmlReporter partial reports', () => {
  it('injects the report into li3 state', () => {
    const html = reporter.generateHtml(report('running'));
    const stateSource = html.match(/<script state>(.*?)<\/script>/s)?.[1];

    expect(html).toContain('<template app>');
    expect(html).toContain('<script setup>');
    expect(JSON.parse(stateSource!)).toEqual({ report: report('running') });
  });

  it('keeps rendering and active refresh behavior in the li3 app', () => {
    const html = reporter.generateHtml(report('running'));

    expect(html).toContain('template for="[step, index] of report.steps"');
    expect(html).toContain('Step is running. Logs will appear after it finishes.');
    expect(html).toContain('Waiting to run.');
    expect(html).toContain('setTimeout(() => location.reload(), 3000)');
  });

  it('escapes state that could terminate its script element', () => {
    const unsafe = report('success');
    unsafe.steps[0].logContent = '</script><script>alert(1)</script>';

    const html = reporter.generateHtml(unsafe);

    expect(html).not.toContain('</script><script>alert(1)</script>');
    expect(html).toContain('\\u003c/script\\u003e');
  });
});
