import { describe, expect, it, vi } from "vitest";
import { RunnerApiClient } from "./runner-api-client.js";

describe("language-neutral runner API client", () => {
  it("sends authenticated requests under the versioned HTTPS API", async () => {
    const fetcher = vi.fn(async () => new Response(JSON.stringify({ ok: true }), { status: 200 }));
    const client = new RunnerApiClient("https://coordinator.example/ignored", "runner-secret", fetcher as typeof fetch);

    await expect(client.json("runner/heartbeat", { method: "POST" })).resolves.toEqual({ ok: true });

    const [url, init] = fetcher.mock.calls[0];
    expect(url).toEqual(new URL("https://coordinator.example/api/v1/runner/heartbeat"));
    expect(new Headers(init?.headers).get("authorization")).toBe("Bearer runner-secret");
  });

  it("requires TLS except for loopback development and never permits escaping the API base", async () => {
    expect(() => new RunnerApiClient("http://coordinator.example", "secret")).toThrow("HTTPS");
    await expect(new RunnerApiClient("https://coordinator.example", "secret").request("../admin")).rejects.toThrow(
      "escaped",
    );
    expect(() => new RunnerApiClient("http://127.0.0.1:3000", "secret")).not.toThrow();
  });

  it("parses event ids, multiline payloads, and ignores unknown or malformed events", async () => {
    const stream = [
      'id: 12\nevent: jobs.available\ndata: {"teamId":\ndata: "team-1"}\n\n',
      "event: future.event\ndata: {}\n\n",
      "event: runner.update\ndata: {bad}\n\n",
    ].join("");
    const fetcher = vi.fn(async () => new Response(stream, { headers: { "Content-Type": "text/event-stream" } }));
    const client = new RunnerApiClient("https://coordinator.example", "runner-secret", fetcher as typeof fetch);
    const events = [];

    for await (const event of client.events(new AbortController().signal)) events.push(event);

    expect(events).toEqual([{ id: "12", event: "jobs.available", data: { teamId: "team-1" } }]);
    const headers = new Headers(fetcher.mock.calls[0][1]?.headers);
    expect(headers.get("authorization")).toBe("Bearer runner-secret");
    expect(headers.get("accept")).toBe("text/event-stream");
  });
});
