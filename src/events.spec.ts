import { afterEach, describe, expect, it, vi } from "vitest";
import { EventBroker, consumeRunnerEvents } from "./events.js";

describe("consumeRunnerEvents", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("parses named SSE events while ignoring heartbeats", async () => {
    const stream = new ReadableStream({
      start(controller) {
        controller.enqueue(
          new TextEncoder().encode(': heartbeat\n\nid: 1\nevent: jobs.available\ndata: {"tags":["docker"]}\n\n'),
        );
        controller.close();
      },
    });
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ ok: true, status: 200, body: stream }));
    const events: unknown[] = [];
    const onOpen = vi.fn();

    await consumeRunnerEvents(
      "http://runner.test",
      new AbortController().signal,
      (event, data) => events.push({ event, data }),
      onOpen,
    );

    expect(onOpen).toHaveBeenCalledOnce();
    expect(events).toEqual([{ event: "jobs.available", data: { tags: ["docker"] } }]);
  });
});

describe("EventBroker team and worker subscriptions", () => {
  it("broadcasts availability to workers but keeps job changes tenant-scoped", () => {
    const broker = new EventBroker();
    const response = () => ({ writeHead: vi.fn(), write: vi.fn(() => true), end: vi.fn() });
    const teamA = response();
    const worker = response();
    broker.subscribe({ once: vi.fn() } as any, teamA as any, "team-a");
    broker.subscribe({ once: vi.fn() } as any, worker as any, undefined, true);
    teamA.write.mockClear();
    worker.write.mockClear();

    broker.publish("jobs.changed", { jobId: 7, teamId: "team-b" });
    broker.publish("jobs.available", { teamId: "team-b" });

    expect(teamA.write).not.toHaveBeenCalled();
    expect(worker.write).toHaveBeenCalledOnce();
    expect(worker.write.mock.calls[0][0]).toContain("event: jobs.available");
    broker.close();
  });
});
