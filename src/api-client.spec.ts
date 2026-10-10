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
  const localValues = new Map<string, string>();
  const sessionStorage = {
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => values.set(key, String(value)),
    removeItem: (key: string) => values.delete(key),
  };
  const localStorage = {
    getItem: (key: string) => localValues.get(key) ?? null,
    setItem: (key: string, value: string) => localValues.set(key, String(value)),
    removeItem: (key: string) => localValues.delete(key),
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
  vi.stubGlobal("localStorage", localStorage);
  vi.stubGlobal("window", { location, fetch });

  return { fetch, location, localStorage, sessionStorage };
}

async function importClient() {
  vi.resetModules();
  return import("../ui/api-client.mjs");
}

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  vi.resetModules();
});

describe("browser API client sign-in recovery", () => {
  it("does not redirect for a token endpoint 401 that lacks the known auth contract", async () => {
    const { location, fetch } = installBrowser([new Response("Unauthorized", { status: 401 })]);
    const { loadToken } = await importClient();

    await expect(loadToken()).resolves.toBe("");

    expect(fetch).toHaveBeenCalledWith("/api/auth/token", { headers: { accept: "application/json" } });
    expect(location.assign).not.toHaveBeenCalled();
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

  it("keeps manually supplied API keys without requesting an OIDC token", async () => {
    const { fetch, sessionStorage } = installBrowser([]);
    const { loadToken, setApiToken } = await importClient();

    setApiToken("manual-api-key");

    await expect(loadToken()).resolves.toBe("manual-api-key");
    expect(fetch).not.toHaveBeenCalled();
    expect(sessionStorage.getItem("runner-api-token")).toBe("manual-api-key");
  });

  it("waits for a user-initiated popup and the session endpoint before retrying once", async () => {
    const authRequired = () =>
      new Response(JSON.stringify({ error: "Authentication required" }), {
        status: 401,
        headers: { "content-type": "application/json" },
      });
    const { fetch, localStorage } = installBrowser([
      new Response(JSON.stringify({ access_token: "expired-token", expires_at: Date.now() + 60_000 })),
      authRequired(),
      new Response(JSON.stringify({ configured: true, authenticated: true }), { status: 200 }),
      new Response(JSON.stringify({ access_token: "fresh-token", expires_at: Date.now() + 60_000 })),
      new Response("ok", { status: 200 }),
    ]);
    const status = { textContent: "" };
    const callbacks = new Map<string, () => void>();
    const loginButton = { addEventListener: (_type: string, callback: () => void) => callbacks.set("login", callback) };
    const cancelButton = {
      addEventListener: (_type: string, callback: () => void) => callbacks.set("cancel", callback),
    };
    const dialog = {
      setAttribute: vi.fn(),
      addEventListener: vi.fn(),
      showModal: vi.fn(),
      close: vi.fn(),
      querySelector: (selector: string) =>
        selector === "[data-auth-status]" ? status : selector === "[data-auth-login]" ? loginButton : cancelButton,
    };
    const windowEvents = new Map<string, () => void>();
    const popup = { closed: false };
    const window = globalThis.window as unknown as { addEventListener: typeof vi.fn; open: typeof vi.fn };
    window.addEventListener = vi.fn((type: string, callback: () => void) => windowEvents.set(type, callback));
    (window as unknown as { removeEventListener: typeof vi.fn }).removeEventListener = vi.fn();
    window.open = vi.fn(() => popup);
    let dialogAdded = false;
    vi.stubGlobal("document", {
      body: { append: vi.fn(() => (dialogAdded = true)) },
      createElement: vi.fn(() => dialog),
      getElementById: vi.fn(() => (dialogAdded ? dialog : null)),
    });
    const { apiFetch } = await importClient();

    const request = apiFetch("/api/jobs");
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(dialog.showModal).toHaveBeenCalledOnce();
    expect(window.open).not.toHaveBeenCalled();
    expect(fetch).toHaveBeenCalledTimes(2);

    callbacks.get("login")?.();
    expect(window.open).toHaveBeenCalledWith(
      expect.stringContaining("/auth/login?url="),
      "runner-auth",
      expect.any(String),
    );
    const popupUrl = new URL(window.open.mock.calls[0][0], "https://flow.example.test");
    const returnUrl = new URL(popupUrl.searchParams.get("url") || "", "https://flow.example.test");
    const nonce = returnUrl.searchParams.get("__runner_auth_nonce");
    expect(nonce).toBeTruthy();
    expect(localStorage.getItem(`runner-auth-recovery:${nonce}`)).toBe("pending");
    expect(fetch).toHaveBeenCalledTimes(2);
    localStorage.setItem(`runner-auth-recovery:${nonce}`, "complete");
    await windowEvents.get("focus")?.();

    const response = await request;
    expect(response.status).toBe(200);
    expect(fetch).toHaveBeenCalledTimes(5);
    expect(new Headers(fetch.mock.calls[4][1]?.headers).get("authorization")).toBe("Bearer fresh-token");
    expect(dialog.close).toHaveBeenCalledOnce();
    expect(localStorage.getItem(`runner-auth-recovery:${nonce}`)).toBeNull();
  });

  it("does not retry a missing-scope 401", async () => {
    const { fetch, location } = installBrowser([
      new Response(JSON.stringify({ access_token: "token", expires_at: Date.now() + 60_000 })),
      new Response(JSON.stringify({ error: "Missing scope: logs:read" }), {
        status: 401,
        headers: { "content-type": "application/json" },
      }),
    ]);
    const { apiFetch } = await importClient();

    const response = await apiFetch("/api/runs/1");

    expect(response.status).toBe(401);
    expect(fetch).toHaveBeenCalledTimes(2);
    expect(location.assign).not.toHaveBeenCalled();
  });

  it("closes a marked login popup only after the runner session check succeeds", async () => {
    const { fetch, location, localStorage } = installBrowser([
      new Response(JSON.stringify({ configured: true, authenticated: true }), {
        status: 200,
        headers: { "content-type": "application/json" },
      }),
    ]);
    location.href = "https://flow.example.test/settings/tokens?tab=active&__runner_auth_nonce=attempt-123#keys";
    localStorage.setItem("runner-auth-recovery:attempt-123", "pending");
    const popupWindow = globalThis.window as unknown as { opener: object; close: ReturnType<typeof vi.fn> };
    popupWindow.opener = {};
    popupWindow.close = vi.fn();
    vi.stubGlobal("history", { replaceState: vi.fn() });

    await importClient();
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(fetch).toHaveBeenCalledWith("/api/auth/session", {
      credentials: "same-origin",
      headers: { accept: "application/json" },
    });
    expect(popupWindow.close).toHaveBeenCalledOnce();
    expect(localStorage.getItem("runner-auth-recovery:attempt-123")).toBe("complete");
  });
});
