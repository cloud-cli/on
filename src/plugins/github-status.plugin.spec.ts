import { afterEach, describe, expect, it, vi } from 'vitest';
import { GitHubStatusPlugin } from './github-status.plugin.js';

describe('GitHubStatusPlugin', () => {
  afterEach(() => vi.unstubAllGlobals());

  it('publishes pending and cancelled commit statuses', async () => {
    const fetchMock = vi.fn().mockResolvedValue({ ok: true, status: 201 });
    vi.stubGlobal('fetch', fetchMock);
    const plugin = new GitHubStatusPlugin({ token: 'github-token', context: 'ci' });
    const workflow = {
      jobId: '42',
      workflowName: 'deploy',
      inputs: { owner: 'cloud-cli', repo: 'on', commit_sha: 'abc123' },
      runUrl: 'https://runner.test/runs/42',
    };

    await plugin.onWorkflowStart(workflow);
    await plugin.onWorkflowFinish(workflow, 'cancelled');

    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(fetchMock.mock.calls[0][0].toString()).toBe('https://api.github.com/repos/cloud-cli/on/statuses/abc123');
    expect(fetchMock.mock.calls[0][1].headers.Authorization).toBe('Bearer github-token');
    expect(JSON.parse(fetchMock.mock.calls[0][1].body)).toEqual({
      state: 'pending',
      target_url: 'https://runner.test/runs/42',
      description: 'Workflow build has started.',
      context: 'ci/deploy',
    });
    expect(JSON.parse(fetchMock.mock.calls[1][1].body).state).toBe('error');
  });
});
