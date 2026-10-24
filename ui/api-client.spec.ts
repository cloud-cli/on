import { beforeEach, describe, expect, it, vi } from "vitest";

describe("API client cancellation", () => {
  beforeEach(() => {
    vi.resetModules();
    const fetch = vi.fn(async () => ({ ok: true, status: 200, json: async () => ({ access_token: "test-token" }) }));
    (globalThis as any).window = {
      fetch,
      location: { href: "http://localhost/ui/runs", origin: "http://localhost" },
      addEventListener: () => {},
    };
    (globalThis as any).sessionStorage = { getItem: () => null, setItem: () => {}, removeItem: () => {} };
    (globalThis as any).localStorage = { getItem: () => null };
  });

  it("propagates request cancellation to token acquisition and the API request", async () => {
    const { apiFetch } = await import("./api-client.mjs");
    const signal = new AbortController().signal;

    await apiFetch("/api/v1/workspaces", { signal });

    const fetch = window.fetch as unknown as ReturnType<typeof vi.fn>;
    expect(fetch).toHaveBeenCalledTimes(2);
    expect(fetch.mock.calls[0][1].signal).toBe(signal);
    expect(fetch.mock.calls[1][1].signal).toBe(signal);
  });
});
