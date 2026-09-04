import { describe, expect, it, vi } from 'vitest';
import type { Processable, WorkflowExecutionReport } from './types.js';
import { processJob } from './worker.js';

describe('incremental workflow reports', () => {
  it('persists every step transition and output', async () => {
    const reports: WorkflowExecutionReport[] = [];
    const logs: Array<{ stepId: string; content: string }> = [];
    const queue = {
      saveReport: vi.fn(async (_jobId, report: WorkflowExecutionReport) => {
        reports.push(structuredClone(report));
      }),
      saveStepLog: vi.fn(async (_jobId, stepId: string, content: string) => {
        logs.push({ stepId, content });
      }),
      completeJob: vi.fn(async (_jobId, _status, report: WorkflowExecutionReport) => {
        reports.push(structuredClone(report));
      }),
      isCancelled: vi.fn(async () => false),
    };
    const payload = {
      inputs: {},
    };
    const workflow = {
      id: 'incremental',
      name: 'Incremental',
      on: { provider: 'generic' },
      steps: [
        { id: 'first', eval: '({ value: 1 })' },
        { id: 'second', eval: '({ value: 2 })' },
      ],
    };

    await processJob({
      workerId: 'test-worker',
      job: {
        id: 1,
        workflow_id: 'incremental',
        workflow_revision: 1,
        required_tags: '[]',
        concurrency_key: null,
        status: 'running',
        worker_id: 'test-worker',
        payload: JSON.stringify(payload),
        created_at: new Date().toISOString(),
      },
      queue,
      secrets: { getAll: () => ({}) },
      config: { storagePath: '/tmp', serverUrl: 'http://runner.test', env: {}, plugins: [] },
      driver: {},
      workflow,
    } as Processable);

    expect(reports.map((report) => report.steps.map((step) => step.status))).toEqual([
      ['pending', 'pending'],
      ['running', 'pending'],
      ['success', 'pending'],
      ['success', 'running'],
      ['success', 'success'],
      ['success', 'success'],
    ]);
    expect(reports.at(-1)?.steps.map((step) => step.outputs)).toEqual([{ value: 1 }, { value: 2 }]);
    expect(logs).toEqual([
      { stepId: 'first', content: '[JS EVAL OUTPUT]:\n{\n  "value": 1\n}' },
      { stepId: 'second', content: '[JS EVAL OUTPUT]:\n{\n  "value": 2\n}' },
    ]);
    expect(queue.completeJob).toHaveBeenCalledWith(1, 'success', expect.any(Object));
  });
});
