import type http from 'node:http';

export type RunnerEvent = 'jobs.available' | 'jobs.changed';

export class EventBroker {
  private clients = new Map<http.ServerResponse, NodeJS.Timeout>();
  private nextId = 1;
  private readonly maxClients = 1000;

  subscribe(req: http.IncomingMessage, res: http.ServerResponse): void {
    if (this.clients.size >= this.maxClients) {
      res.writeHead(503, { 'Content-Type': 'application/json', 'Retry-After': '5' });
      res.end(JSON.stringify({ error: 'Too many event stream clients' }));
      return;
    }

    res.writeHead(200, {
      'Cache-Control': 'no-cache, no-transform',
      Connection: 'keep-alive',
      'Content-Type': 'text/event-stream',
      'X-Accel-Buffering': 'no',
    });
    res.write('retry: 2000\n\n');
    const heartbeat = setInterval(() => res.write(': heartbeat\n\n'), 30_000);
    heartbeat.unref();
    this.clients.set(res, heartbeat);
    req.once('close', () => {
      clearInterval(heartbeat);
      this.clients.delete(res);
    });
  }

  publish(event: RunnerEvent, data: Record<string, unknown> = {}): void {
    const message = `id: ${this.nextId++}\nevent: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
    for (const [client, heartbeat] of this.clients) {
      if (client.write(message)) continue;
      clearInterval(heartbeat);
      this.clients.delete(client);
      client.end();
    }
  }

  close(): void {
    for (const [client, heartbeat] of this.clients) {
      clearInterval(heartbeat);
      client.end();
    }
    this.clients.clear();
  }
}

export async function consumeRunnerEvents(
  serverUrl: string,
  signal: AbortSignal,
  onEvent: (event: RunnerEvent, data: Record<string, unknown>) => void,
  onOpen?: () => void,
): Promise<void> {
  const response = await fetch(new URL('/api/events', serverUrl), {
    headers: { Accept: 'text/event-stream' },
    signal,
  });

  if (!response.ok || !response.body) throw new Error(`Event stream failed with HTTP ${response.status}`);
  onOpen?.();

  const decoder = new TextDecoder();
  let buffer = '';

  for await (const chunk of response.body) {
    buffer += decoder.decode(chunk, { stream: true }).replaceAll('\r\n', '\n');
    let boundary = buffer.indexOf('\n\n');

    while (boundary !== -1) {
      const frame = buffer.slice(0, boundary);
      buffer = buffer.slice(boundary + 2);
      boundary = buffer.indexOf('\n\n');

      const event = frame.match(/^event: (.+)$/m)?.[1] as RunnerEvent | undefined;
      if (!event) continue;

      const rawData = frame.match(/^data: (.*)$/m)?.[1];
      onEvent(event, rawData ? JSON.parse(rawData) : {});
    }
  }
}
