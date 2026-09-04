import { describe, expect, it } from 'vitest';
import { buildRunView, renderRunHtml, type RunView } from './run-view.js';
import type { WorkflowExecutionReport } from './types.js';

function report(status: WorkflowExecutionReport['status']): WorkflowExecutionReport {
  return {
    jobId: '42',
    parentId: '',
    workflowName: 'deploy',
    status,
    durationMs: 250,
    startedAt: '2026-09-04T00:00:00.000Z',
    inputs: { branch: 'main' },
    environment: { SECRET_TOKEN: 'hidden' },
    steps: [
      {
        id: 'build',
        name: 'Build',
        status: 'success',
        durationMs: 100,
        exitCode: 0,
        outputs: { artifact: 'app.tar' },
        logContent: '',
      },
      {
        id: 'deploy',
        name: 'Deploy',
        status: 'running',
        durationMs: 0,
        outputs: {},
        logContent: '',
      },
    ],
    artifacts: [],
    rerunToken: '{"secret":"hidden"}',
  };
}

function view(status: RunView['status']): RunView {
  return {
    jobId: '42',
    parentId: '',
    workflowName: 'deploy',
    status,
    durationMs: 250,
    startedAt: '2026-09-04T00:00:00.000Z',
    inputs: { branch: 'main' },
    steps: report(status).steps,
    artifacts: [],
  };
}

describe('run view', () => {
  it('removes private report fields and redacts exposed values', () => {
    const storedReport = report('success');
    storedReport.inputs = {
      branch: 'main',
      raw: { installation: 'private' },
      accessToken: 'private',
      access_key: 'private',
      passphrase: 'private',
      message: 'contains top-secret',
    };
    const runView = buildRunView(
      {
        id: 42,
        workflow_id: 'deploy',
        status: 'success',
        payload: JSON.stringify({ workflowId: 'deploy', inputs: {}, steps: [] }),
        report: JSON.stringify(storedReport),
      } as any,
      { build: 'using top-secret' },
      (value) => value.replaceAll('top-secret', '****'),
    );

    expect(runView.inputs).toEqual({ branch: 'main', message: 'contains ****' });
    expect(runView.steps[0].logContent).toBe('using ****');
    expect(runView).not.toHaveProperty('environment');
    expect(runView).not.toHaveProperty('rerunToken');
  });

  it('does not read inherited properties as step logs', () => {
    const storedReport = report('success');
    storedReport.steps[0].id = 'toString';
    const runView = buildRunView(
      {
        id: 42,
        workflow_id: 'deploy',
        status: 'success',
        payload: JSON.stringify({ workflowId: 'deploy', inputs: {}, steps: [] }),
        report: JSON.stringify(storedReport),
      } as any,
      {},
      (value) => value,
    );

    expect(runView.steps[0].logContent).toBe('');
  });

  it('injects escaped state and SSE refresh behavior into HTML', () => {
    const unsafe = view('running');
    unsafe.steps[0].logContent = '</script><script>alert(1)</script>';
    const html = renderRunHtml(unsafe);
    const stateSource = html.match(/<script state>(.*?)<\/script>/s)?.[1];

    expect(JSON.parse(stateSource!)).toEqual({ report: unsafe });
    expect(html).toContain('template for="[step, index] of report.steps"');
    expect(html).toContain("new EventSource('/api/events')");
    expect(html).toContain("addEventListener('jobs.changed', handleJobChange)");
    expect(html).toContain('fetch(`/api/runs/${report.value.jobId}`');
    expect(html).toContain('now.value = Date.now()');
    expect(html).not.toContain('location.reload()');
    expect(html).not.toContain('</script><script>alert(1)</script>');
    expect(html).toContain('\\u003c/script\\u003e');
  });
});
