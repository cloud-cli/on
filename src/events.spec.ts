import { afterEach, describe, expect, it, vi } from 'vitest';
import { consumeRunnerEvents } from './events.js';

describe('consumeRunnerEvents', () => {
  afterEach(() => vi.unstubAllGlobals());

  it('parses named SSE events while ignoring heartbeats', async () => {
    const stream = new ReadableStream({
      start(controller) {
        controller.enqueue(new TextEncoder().encode(': heartbeat\n\nid: 1\nevent: jobs.available\ndata: {"tags":["docker"]}\n\n'));
        controller.close();
      },
    });
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: true, status: 200, body: stream }));
    const events: unknown[] = [];
    const onOpen = vi.fn();

    await consumeRunnerEvents(
      'http://runner.test',
      new AbortController().signal,
      (event, data) => events.push({ event, data }),
      onOpen,
    );

    expect(onOpen).toHaveBeenCalledOnce();
    expect(events).toEqual([{ event: 'jobs.available', data: { tags: ['docker'] } }]);
  });
});
