import { describe, expect, it, vi } from "vitest";
import { RunnerApi } from "./runner-api.js";

describe("RunnerApi", () => {
  it("sends authenticated claim and fenced lease requests", async () => {
    const fetcher = vi.fn(
      async (_input: URL | RequestInfo, _init?: RequestInit) =>
        new Response(JSON.stringify({ leaseId: "lease-1", leaseToken: "fence", job: { id: 3 }, workflow: {} }), {
          headers: { "Content-Type": "application/json" },
        }),
    );
    const api = new RunnerApi("https://runner.example", "onr-secret", fetcher as typeof fetch);
    const lease = await api.claim(["docker"]);
    expect(lease?.leaseId).toBe("lease-1");
    const [url, request] = fetcher.mock.calls[0];
    expect(url).toEqual(new URL("https://runner.example/api/v1/runner/leases"));
    expect(new Headers(request?.headers).get("authorization")).toBe("Bearer onr-secret");
    expect(JSON.parse(String(request?.body))).toEqual({ tags: ["docker"] });
  });

  it("requires HTTPS outside loopback and handles an empty claim", async () => {
    expect(() => new RunnerApi("http://coordinator.example", "credential")).toThrow("HTTPS");
    const api = new RunnerApi(
      "http://localhost:3000",
      "credential",
      vi.fn(async () => new Response(null, { status: 204 })) as typeof fetch,
    );
    await expect(api.claim([])).resolves.toBeNull();
  });

  it("unwraps coordinator job secrets before passing them to the runner", async () => {
    const fetcher = vi.fn(async () => new Response(JSON.stringify({ secrets: { DEPLOY_TOKEN: "redacted" } })));
    const api = new RunnerApi("https://runner.example", "credential", fetcher as typeof fetch);
    const lease = { leaseId: "lease-1", leaseToken: "fence", job: { id: 3 }, workflow: {} };
    await expect(api.secrets(lease)).resolves.toEqual({ DEPLOY_TOKEN: "redacted" });
  });
});
