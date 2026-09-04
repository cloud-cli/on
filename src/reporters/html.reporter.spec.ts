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
  it('renders completed logs while withholding active step logs', () => {
    const html = reporter.generateHtml(report('running'));

    expect(html).toContain('build complete');
    expect(html).toContain('Step is running. Logs will appear after it finishes.');
    expect(html).toContain('Waiting to run.');
  });

  it('refreshes active reports', () => {
    expect(reporter.generateHtml(report('running'))).toContain('<meta http-equiv="refresh" content="3">');
    expect(reporter.generateHtml(report('pending'))).toContain('<meta http-equiv="refresh" content="3">');
    expect(reporter.generateHtml(report('success'))).not.toContain('<meta http-equiv="refresh" content="3">');
  });
});
