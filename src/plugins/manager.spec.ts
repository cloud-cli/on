import { describe, expect, it, vi } from 'vitest';
import { PluginManager } from './manager.js';

describe('PluginManager', () => {
  it('isolates synchronous plugin failures', async () => {
    const onWorkflowStart = vi.fn(async () => {});
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {});
    const manager = new PluginManager([
      {
        name: 'broken',
        onWorkflowStart() {
          throw new Error('broken');
        },
      },
      { name: 'healthy', onWorkflowStart },
    ]);

    await manager.triggerWorkflowStart({
      jobId: '42',
      workflowName: 'deploy',
      inputs: {},
      runUrl: 'https://runner.test/runs/42',
    });

    expect(onWorkflowStart).toHaveBeenCalledOnce();
    expect(consoleError).toHaveBeenCalledOnce();
    consoleError.mockRestore();
  });
});
