import { afterEach, describe, expect, it, vi } from 'vitest';
import { setUrl } from './db-client.js';
import { QueueManager } from './queue.js';

describe('QueueManager.listJobs', () => {
  afterEach(() => vi.unstubAllGlobals());

  it('optionally requests jobs between inclusive and exclusive ID cursors', async () => {
    setUrl('http://database.test');
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => [],
    });
    vi.stubGlobal('fetch', fetchMock);

    await new QueueManager('test').listJobs(51, 42, 100);

    const request = JSON.parse(fetchMock.mock.calls[0][1].body);
    expect(request).toMatchObject({
      m: 'all',
      s: 'SELECT * FROM jobs WHERE id > ? AND id < ? ORDER BY id DESC LIMIT ?;',
      d: [42, 100, 51],
    });
  });
});

describe('QueueManager.claimNextJob', () => {
  afterEach(() => vi.unstubAllGlobals());

  it('atomically claims only jobs whose required tags are all supported', async () => {
    setUrl('http://database.test');
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => null,
    });
    vi.stubGlobal('fetch', fetchMock);

    await new QueueManager('build-node').claimNextJob(['linux', 'docker']);

    const request = JSON.parse(fetchMock.mock.calls[0][1].body);
    expect(request.m).toBe('get');
    expect(request.s).toContain("json_each(COALESCE(jobs.required_tags, '[]'))");
    expect(request.s).toContain('required_tag.value NOT IN (SELECT value FROM json_each(?))');
    expect(request.d).toEqual(['build-node', '["linux","docker"]']);
  });
});
