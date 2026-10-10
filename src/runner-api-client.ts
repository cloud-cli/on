export type RunnerEventName = "jobs.available" | "lease.cancelled" | "runner.drain" | "runner.update";

export interface RunnerEvent {
  id?: string;
  event: RunnerEventName;
  data: Record<string, unknown>;
}

/** Language-neutral v1 coordinator transport. It never imports worker or database code. */
export class RunnerApiClient {
  private readonly apiBase: URL;

  constructor(
    serverUrl: string,
    private readonly credential: string,
    private readonly fetcher: typeof fetch = fetch,
  ) {
    const base = new URL(serverUrl);
    const isLoopback = ["localhost", "127.0.0.1", "::1"].includes(base.hostname);
    if (base.protocol !== "https:" && !(base.protocol === "http:" && isLoopback)) {
      throw new Error("Runner coordinator URLs must use HTTPS outside loopback");
    }
    if (!credential.trim()) {
      throw new Error("Runner coordinator credential is required");
    }
    this.apiBase = new URL("/api/v1/", base);
  }

  async request(path: string, init: RequestInit = {}): Promise<Response> {
    const url = this.endpoint(path);
    const headers = new Headers(init.headers);
    headers.set("Authorization", `Bearer ${this.credential}`);
    headers.set("Accept", headers.get("Accept") || "application/json");
    const response = await this.fetcher(url, { ...init, headers });
    if (!response.ok && response.status !== 204) {
      throw new Error(`Runner coordinator request failed (${response.status})`);
    }
    return response;
  }

  async json<T>(path: string, init: RequestInit = {}): Promise<T> {
    const response = await this.request(path, init);
    if (response.status === 204) return undefined as T;
    return (await response.json()) as T;
  }

  async *events(signal: AbortSignal, lastEventId?: string): AsyncGenerator<RunnerEvent> {
    const headers = new Headers({ Accept: "text/event-stream" });
    if (lastEventId) headers.set("Last-Event-ID", lastEventId);
    const response = await this.request("runner/events", { headers, signal });
    if (!response.body) throw new Error("Runner coordinator returned an empty event stream");

    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";
    try {
      while (!signal.aborted) {
        const { value, done } = await reader.read();
        if (done) return;
        buffer += decoder.decode(value, { stream: true }).replaceAll("\r\n", "\n");
        let boundary = buffer.indexOf("\n\n");
        while (boundary !== -1) {
          const frame = buffer.slice(0, boundary);
          buffer = buffer.slice(boundary + 2);
          boundary = buffer.indexOf("\n\n");
          const event = parseRunnerEvent(frame);
          if (event) yield event;
        }
      }
    } finally {
      await reader.cancel().catch(() => undefined);
      reader.releaseLock();
    }
  }

  private endpoint(path: string): URL {
    if (!path || path.startsWith("/") || path.includes("\\")) {
      throw new Error("Runner API paths must be relative to /api/v1");
    }
    const url = new URL(path, this.apiBase);
    if (url.origin !== this.apiBase.origin || !url.pathname.startsWith(this.apiBase.pathname)) {
      throw new Error("Runner API path escaped the coordinator API base");
    }
    return url;
  }
}

function parseRunnerEvent(frame: string): RunnerEvent | undefined {
  let id: string | undefined;
  let event: string | undefined;
  const data: string[] = [];
  for (const line of frame.split("\n")) {
    if (!line || line.startsWith(":")) continue;
    const separator = line.indexOf(":");
    const field = separator === -1 ? line : line.slice(0, separator);
    const value = separator === -1 ? "" : line.slice(separator + 1).replace(/^ /, "");
    if (field === "id") id = value;
    if (field === "event") event = value;
    if (field === "data") data.push(value);
  }
  if (!event || !["jobs.available", "lease.cancelled", "runner.drain", "runner.update"].includes(event)) return;
  try {
    const parsed = data.length ? JSON.parse(data.join("\n")) : {};
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return;
    return { id, event: event as RunnerEventName, data: parsed as Record<string, unknown> };
  } catch {
    return;
  }
}
