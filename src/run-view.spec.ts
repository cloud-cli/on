import { describe, expect, it } from 'vitest';
import { buildRunView, renderRunHtml, type RunView } from './run-view.js';
import type { WorkflowExecutionReport } from './types.js';
import runSetup from './run.mjs?raw';

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
    canViewLogs: true,
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

    expect(runView.inputs).toEqual({
      branch: 'main',
      raw: { installation: 'private' },
      message: 'contains ****',
    });
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

  it('omits logs from unauthenticated views', () => {
    const storedReport = report('success');
    storedReport.steps[0].logContent = 'private report log';
    const runView = buildRunView(
      {
        id: 42,
        workflow_id: 'deploy',
        status: 'success',
        payload: JSON.stringify({ workflowId: 'deploy', inputs: {}, steps: [] }),
        report: JSON.stringify(storedReport),
      } as any,
      { build: 'private step log' },
      (value) => value,
      [],
      false,
    );

    expect(runView.canViewLogs).toBe(false);
    expect(runView.steps[0].name).toBe('Build');
    expect(runView.steps[0].logContent).toBe('');
  });

  it('injects escaped state and SSE refresh behavior into HTML', () => {
    const unsafe = view('running');
    unsafe.steps[0].logContent = '</script><script>alert(1)</script>';
    const html = renderRunHtml(unsafe);
    const source = html + runSetup;
    expect(source).not.toContain('<script state>');
    expect(source).toContain("bind-title=\"report.workflowName\"");
    expect(source).toContain('apiFetch(`/api/runs/${jobId}`');
    expect(source).toContain('lucide-icon');
    expect(source).toContain('Workflow source YAML');
    expect(source).toContain('Get AI help for failed step');
    expect(source).toContain('/ai-help');
    expect(source).toContain('Previous runs');
    expect(source).toContain("body: JSON.stringify({ inputs: report.value.inputs || {} })");
    expect(source).toContain('Original inputs');
    expect(source).toContain('setManualKey(entry, $event)');
    expect(source).toContain('report.parentId');
    expect(source).toContain('/api/runs/${parentId}');
    expect(source).toContain('Artifacts');
    expect(source).toContain('Thinking through the failed step');
    expect(source).toContain('marked.parse(content)');
    expect(source).toContain('downloadArtifact($event, artifact)');
    expect(source).toContain('https://sodium.static.apphor.de/code-block.html');
    expect(source).toContain('bind-source="inputsJson"');
    expect(source).toContain("'circle-check'");
    expect(source).toContain('worker: {{ report.workerId }}');
    expect(source).toContain("new EventSource('/api/events')");
    expect(source).toContain("addEventListener('jobs.changed', handleJobChange)");
    expect(source).toContain('apiFetch(`/api/runs/${jobId}`');
    expect(source).toContain('now.value = Date.now()');
    expect(source).toContain('href="/manifest.webmanifest"');
    expect(source).toContain("navigator.serviceWorker.register('/service-worker.js')");
    expect(source).toContain('registration.showNotification(');
    expect(source).not.toContain('location.reload()');
    expect(source).not.toContain('</script><script>alert(1)</script>');
    expect(source).not.toContain('unsafe');
  });
});
