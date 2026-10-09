import { afterEach, describe, expect, it, vi } from "vitest";

type BrowserLocation = {
  origin: string;
  href: string;
  pathname: string;
  search: string;
  hash: string;
  assign: ReturnType<typeof vi.fn>;
};

function installBrowser(responses: Response[]) {
  const values = new Map<string, string>();
  const sessionStorage = {
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => values.set(key, String(value)),
    removeItem: (key: string) => values.delete(key),
  };
  const location: BrowserLocation = {
    origin: "https://flow.example.test",
    href: "https://flow.example.test/settings/tokens?tab=active#keys",
    pathname: "/settings/tokens",
    search: "?tab=active",
    hash: "#keys",
    assign: vi.fn(),
  };
  const fetch = vi.fn(async () => responses.shift() ?? new Response(null, { status: 204 }));

  vi.stubGlobal("sessionStorage", sessionStorage);
  vi.stubGlobal("window", { location, fetch });

  return { fetch, location, sessionStorage };
}

async function importClient() {
  vi.resetModules();
  return import("./api-client.mjs");
}

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  vi.resetModules();
});

describe("browser API client sign-in recovery", () => {
  it("redirects to sign-in when the OIDC token endpoint returns 401 without a cached token", async () => {
    const { location, fetch } = installBrowser([new Response("Unauthorized", { status: 401 })]);
    const { loadToken } = await importClient();

    await expect(loadToken()).resolves.toBe("");

    expect(fetch).toHaveBeenCalledWith("/api/auth/token", { headers: { accept: "application/json" } });
    expect(location.assign).toHaveBeenCalledWith("/auth/login?url=%2Fsettings%2Ftokens%3Ftab%3Dactive%23keys");
  });

  it("does not redirect for non-401 token endpoint errors", async () => {
    const { location } = installBrowser([new Response("Unavailable", { status: 503 })]);
    const { loadToken } = await importClient();

    await expect(loadToken()).resolves.toBe("");

    expect(location.assign).not.toHaveBeenCalled();
  });

  it("acquires an OIDC token and sends it to same-origin API calls", async () => {
    const { fetch } = installBrowser([
      new Response(JSON.stringify({ access_token: "oidc-access-token", expires_at: Date.now() + 60_000 }), {
        status: 200,
        headers: { "content-type": "application/json" },
      }),
      new Response(JSON.stringify({ jobs: [], hasMore: false }), {
        status: 200,
        headers: { "content-type": "application/json" },
      }),
    ]);
    const { apiFetch } = await importClient();

    const response = await apiFetch("/api/jobs");

    expect(response.status).toBe(200);
    expect(fetch).toHaveBeenCalledTimes(2);
    expect(new Headers(fetch.mock.calls[1][1]?.headers).get("authorization")).toBe("Bearer oidc-access-token");
  });

  it("preserves an explicitly selected team header on API requests", async () => {
    const { fetch } = installBrowser([
      new Response(JSON.stringify({ access_token: "oidc-access-token", expires_at: Date.now() + 60_000 }), {
        status: 200,
        headers: { "content-type": "application/json" },
      }),
      new Response(JSON.stringify({ members: [] }), {
        status: 200,
        headers: { "content-type": "application/json" },
      }),
    ]);
    const { apiFetch } = await importClient();

    await apiFetch("/api/teams/team-b/members", { headers: { "X-Team-ID": "team-b" } });

    expect(new Headers(fetch.mock.calls[1][1]?.headers).get("X-Team-ID")).toBe("team-b");
  });

  it("keeps manually supplied API keys without requesting an OIDC token", async () => {
    const { fetch, sessionStorage } = installBrowser([]);
    const { loadToken, setApiToken } = await importClient();

    setApiToken("manual-api-key");

    await expect(loadToken()).resolves.toBe("manual-api-key");
    expect(fetch).not.toHaveBeenCalled();
    expect(sessionStorage.getItem("runner-api-token")).toBe("manual-api-key");
  });
});
