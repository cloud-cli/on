import { afterEach, describe, expect, it, vi } from "vitest";
import { OidcClient } from "./oidc.js";

describe("OIDC client", () => {
  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it("performs PKCE login and creates a session from userinfo", async () => {
    const fetchMock = vi.spyOn(globalThis, "fetch").mockImplementation(async (input) => {
      const url = String(input);
      if (url.endsWith("/node.mjs")) {
        return new Response(
          `
        export function createAuthClient() {
          return {
            createAuthorizationRequest({ redirectUri, scope }) {
              return { url: 'https://auth.test/authorize?response_type=code&code_challenge_method=S256&scope=' + encodeURIComponent(scope) + '&redirect_uri=' + encodeURIComponent(redirectUri), codeVerifier: 'verifier' };
            },
            async exchangeCode() { return { access_token: 'access-token', expires_in: 900, refresh_token: 'refresh-token' }; },
            async getUserInfo() { return { sub: 'user-1', preferred_username: 'ada', email: 'ada@example.test', picture: 'https://auth.test/ada.png' }; },
            async introspectToken() { return { active: true, scope: 'logs:read runs:dispatch' }; },
          };
        }
      `,
          { status: 200 },
        );
      }
      throw new Error(`Unexpected request: ${url}`);
    });
    const client = new OidcClient({ providerUrl: "https://auth.test", clientId: "runner", clientSecret: "secret" });

    const loginUrl = await client.loginUrl("https://runner.test/auth/callback", "/runs/42");
    const state = new URL(loginUrl).searchParams.get("state");
    expect(new URL(loginUrl).searchParams.get("code_challenge_method")).toBe("S256");
    expect(new URL(loginUrl).searchParams.get("scope")).toBe("openid profile email offline_access");

    const result = await client.completeLogin("code", state!, "https://runner.test/auth/callback");
    expect(result.returnTo).toBe("/runs/42");
    expect(result.cookie).toContain("runner_oidc_session=");
    expect(client.userFromCookie(result.cookie)).toEqual({
      sub: "user-1",
      preferred_username: "ada",
      email: "ada@example.test",
      picture: "https://auth.test/ada.png",
      id: "user-1",
      name: "ada",
      photo: "https://auth.test/ada.png",
    });
    client.setRole(result.cookie, "admin");
    expect(client.roleFromCookie(result.cookie)).toBe("admin");
    client.setRoleForUser("user-1", "user");
    expect(client.roleFromCookie(result.cookie)).toBe("user");
    client.setRoleForUser("another-user", "admin");
    expect(client.roleFromCookie(result.cookie)).toBe("user");
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("refreshes an expiring access token once for concurrent requests and stores the rotated refresh token", async () => {
    vi.useFakeTimers();
    const refreshRequests: URLSearchParams[] = [];
    vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
      const url = String(input);
      if (url.endsWith("/node.mjs")) {
        return new Response(
          `export function createAuthClient() { return {
            createAuthorizationRequest: () => ({ url: 'https://auth.test/authorize', codeVerifier: 'verifier' }),
            exchangeCode: async () => ({ access_token: 'initial-access', expires_in: 60, refresh_token: 'initial-refresh' }),
            getUserInfo: async () => ({ sub: 'user-1' }),
          }; }`,
          { status: 200 },
        );
      }
      if (url === "https://auth.test/token") {
        refreshRequests.push(new URLSearchParams(String(init?.body)));
        return new Response(
          JSON.stringify({ access_token: "refreshed-access", expires_in: 900, refresh_token: "rotated-refresh" }),
          { status: 200, headers: { "content-type": "application/json" } },
        );
      }
      throw new Error(`Unexpected request: ${url}`);
    });
    const client = new OidcClient({ providerUrl: "https://auth.test", clientId: "runner", clientSecret: "secret" });
    const loginUrl = await client.loginUrl("https://runner.test/auth/callback", "/runs");
    const state = new URL(loginUrl).searchParams.get("state");
    const { cookie } = await client.completeLogin("code", state!, "https://runner.test/auth/callback");

    vi.setSystemTime(Date.now() + 31_000);
    const [first, second] = await Promise.all([
      client.accessTokenFromCookie(cookie),
      client.accessTokenFromCookie(cookie),
    ]);

    expect(first).toEqual(second);
    expect(first?.accessToken).toBe("refreshed-access");
    expect(refreshRequests).toHaveLength(1);
    expect(Object.fromEntries(refreshRequests[0])).toEqual({
      grant_type: "refresh_token",
      client_id: "runner",
      client_secret: "secret",
      refresh_token: "initial-refresh",
    });

    vi.setSystemTime(Date.now() + 871_000);
    const next = await client.accessTokenFromCookie(cookie);
    expect(next?.accessToken).toBe("refreshed-access");
    expect(refreshRequests).toHaveLength(2);
    expect(refreshRequests[1].get("refresh_token")).toBe("rotated-refresh");
  });

  it("keeps the session on transient refresh errors and expires it on an invalid refresh token", async () => {
    let refreshStatus = 503;
    vi.useFakeTimers();
    vi.spyOn(globalThis, "fetch").mockImplementation(async (input) => {
      const url = String(input);
      if (url.endsWith("/node.mjs")) {
        return new Response(
          `export function createAuthClient() { return {
            createAuthorizationRequest: () => ({ url: 'https://auth.test/authorize', codeVerifier: 'verifier' }),
            exchangeCode: async () => ({ access_token: 'initial-access', expires_in: 60, refresh_token: 'refresh-token' }),
            getUserInfo: async () => ({ sub: 'user-1' }),
          }; }`,
          { status: 200 },
        );
      }
      return new Response(JSON.stringify({ error: "invalid_grant" }), { status: refreshStatus });
    });
    const client = new OidcClient({ providerUrl: "https://auth.test", clientId: "runner", clientSecret: "secret" });
    const loginUrl = await client.loginUrl("https://runner.test/auth/callback", "/runs");
    const state = new URL(loginUrl).searchParams.get("state");
    const { cookie } = await client.completeLogin("code", state!, "https://runner.test/auth/callback");
    vi.setSystemTime(Date.now() + 31_000);

    await expect(client.accessTokenFromCookie(cookie)).rejects.toThrow("OIDC token refresh failed: 503");
    expect(client.userFromCookie(cookie)).toBeTruthy();

    refreshStatus = 400;
    await expect(client.accessTokenFromCookie(cookie)).resolves.toBeUndefined();
    expect(client.userFromCookie(cookie)).toBeUndefined();
  });

  it("returns scopes from provider token introspection", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(
        `export function createAuthClient() { return { introspectToken: async () => ({ active: true, scope: 'logs:read runs:dispatch' }) }; }`,
        { status: 200 },
      ),
    );
    const client = new OidcClient({ providerUrl: "https://auth.test", clientId: "runner", clientSecret: "secret" });
    await expect(client.scopesForToken("token")).resolves.toEqual(["logs:read", "runs:dispatch"]);
  });

  it("uses the Node integration's getUserInfo method and handles an empty profile safely", async () => {
    vi.spyOn(globalThis, "fetch").mockImplementation(async (input) => {
      if (String(input).endsWith("/node.mjs")) {
        return new Response(
          `export function createAuthClient() { return {
            createAuthorizationRequest: () => ({ url: 'https://auth.test/authorize', codeVerifier: 'verifier' }),
            exchangeCode: async () => ({ access_token: 'access-token', refresh_token: 'refresh-token' }),
            getUserInfo: async () => null,
          }; }`,
          { status: 200 },
        );
      }
      throw new Error(`Unexpected request: ${String(input)}`);
    });
    const client = new OidcClient({ providerUrl: "https://auth.test", clientId: "runner", clientSecret: "secret" });
    const loginUrl = await client.loginUrl("https://runner.test/auth/callback", "/runs");
    const state = new URL(loginUrl).searchParams.get("state");

    await expect(client.completeLogin("code", state!, "https://runner.test/auth/callback")).rejects.toThrow(
      "OIDC userinfo response was empty",
    );
  });
});
