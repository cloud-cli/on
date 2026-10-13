import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const oidcMocks = vi.hoisted(() => ({
  Configuration: vi.fn(),
  authorizationCodeGrant: vi.fn(),
  buildAuthorizationUrl: vi.fn(),
  discovery: vi.fn(),
  fetchUserInfo: vi.fn(),
  refreshTokenGrant: vi.fn(),
  tokenIntrospection: vi.fn(),
}));

vi.mock("openid-client", () => ({
  ClientSecretBasic: vi.fn((secret: string) => ({ basic: secret })),
  ClientSecretPost: vi.fn((secret: string) => ({ secret })),
  Configuration: oidcMocks.Configuration,
  authorizationCodeGrant: oidcMocks.authorizationCodeGrant,
  buildAuthorizationUrl: oidcMocks.buildAuthorizationUrl,
  discovery: oidcMocks.discovery,
  fetchUserInfo: oidcMocks.fetchUserInfo,
  refreshTokenGrant: oidcMocks.refreshTokenGrant,
  skipSubjectCheck: Symbol("skip-subject-check"),
  tokenIntrospection: oidcMocks.tokenIntrospection,
}));

import { OidcClient } from "./oidc.js";

describe("OIDC client", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    oidcMocks.Configuration.mockImplementation(function (metadata) {
      return { serverMetadata: () => metadata };
    });
    oidcMocks.discovery.mockResolvedValue({
      authorization_endpoint: "https://auth.test/authorize",
      serverMetadata: () => ({ issuer: "https://auth.test" }),
    });
    oidcMocks.buildAuthorizationUrl.mockImplementation((_configuration, parameters) => {
      const url = new URL("https://auth.test/authorize");
      for (const [key, value] of Object.entries(parameters)) {
        url.searchParams.set(key, String(value));
      }
      return url;
    });
    oidcMocks.authorizationCodeGrant.mockResolvedValue({
      access_token: "access-token",
      refresh_token: "refresh-token",
      expires_in: 900,
      claims: () => ({ sub: "user-1" }),
    });
    oidcMocks.fetchUserInfo.mockResolvedValue({
      sub: "user-1",
      preferred_username: "ada",
      email: "ada@example.test",
      picture: "https://auth.test/ada.png",
    });
  });

  afterEach(() => vi.restoreAllMocks());

  it("uses openid-client for discovery, PKCE, nonce, code exchange, and userinfo", async () => {
    const client = new OidcClient({ providerUrl: "https://auth.test/", clientId: "runner", clientSecret: "secret" });
    const loginUrl = await client.loginUrl("https://runner.test/auth/callback", "/runs/42");
    const authorization = new URL(loginUrl);
    const state = authorization.searchParams.get("state")!;

    expect(client.providerUrl).toBe("https://auth.test");
    expect(authorization.searchParams.get("code_challenge_method")).toBe("S256");
    expect(authorization.searchParams.get("scope")).toBe("openid profile email offline_access");
    expect(authorization.searchParams.get("nonce")).toBeTruthy();
    expect(oidcMocks.discovery).toHaveBeenCalledOnce();

    const result = await client.completeLogin("code", state, "https://runner.test/auth/callback");
    expect(result.returnTo).toBe("/runs/42");
    expect(result.cookie).toContain("runner_oidc_session=");
    expect(oidcMocks.authorizationCodeGrant).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ searchParams: expect.any(URLSearchParams) }),
      expect.objectContaining({
        expectedState: state,
        expectedNonce: authorization.searchParams.get("nonce"),
        pkceCodeVerifier: expect.any(String),
      }),
    );
    expect(oidcMocks.fetchUserInfo).toHaveBeenCalledWith(expect.anything(), "access-token", "user-1");
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
  });

  it("rejects an ID token and userinfo subject mismatch", async () => {
    oidcMocks.fetchUserInfo.mockResolvedValue({ sub: "another-user" });
    const client = new OidcClient({ providerUrl: "https://auth.test", clientId: "runner", clientSecret: "secret" });
    const loginUrl = await client.loginUrl("https://runner.test/auth/callback", "/runs");
    await expect(
      client.completeLogin("code", new URL(loginUrl).searchParams.get("state")!, "https://runner.test/auth/callback"),
    ).rejects.toThrow("OIDC userinfo subject did not match the ID token");
  });

  it("uses openid-client for bearer-token userinfo and introspection", async () => {
    const client = new OidcClient({ providerUrl: "https://auth.test", clientId: "runner", clientSecret: "secret" });
    await expect(client.userFromAccessToken("access-token")).resolves.toMatchObject({ id: "user-1", name: "ada" });
    expect(oidcMocks.fetchUserInfo).toHaveBeenCalledWith(expect.anything(), "access-token", expect.anything());

    oidcMocks.tokenIntrospection.mockResolvedValue({ active: true, scope: "logs:read runs:dispatch" });
    await expect(client.scopesForToken("access-token")).resolves.toEqual(["logs:read", "runs:dispatch"]);
    expect(oidcMocks.Configuration).toHaveBeenCalledWith(
      { issuer: "https://auth.test", introspection_endpoint: "https://auth.test/oauth/introspect" },
      "runner",
      undefined,
      { basic: "secret" },
    );
  });

  it("refreshes expiring sessions with openid-client", async () => {
    const client = new OidcClient({ providerUrl: "https://auth.test", clientId: "runner", clientSecret: "secret" });
    const sessionToken = "session-token";
    (client as any).sessions.set(sessionToken, {
      user: { id: "user-1" },
      accessToken: "old-token",
      refreshToken: "refresh-token",
      accessTokenExpiresAt: Date.now() - 1000,
      expiresAt: Date.now() + 60_000,
    });
    oidcMocks.refreshTokenGrant.mockResolvedValue({ access_token: "new-token", expires_in: 600 });

    await expect(client.accessTokenFromCookie(`runner_oidc_session=${sessionToken}`)).resolves.toMatchObject({
      accessToken: "new-token",
    });
    expect(oidcMocks.refreshTokenGrant).toHaveBeenCalledWith(expect.anything(), "refresh-token");
  });

  it("delegates audience-bound token APIs to the provider's node.mjs Auth client", async () => {
    const fetchMock = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValue(
        new Response(
          `export function createAuthClient() { return { request: async (path, options) => ({ path, options }) }; }`,
          { status: 200 },
        ),
      );
    const client = new OidcClient({ providerUrl: "https://auth.test", clientId: "runner", clientSecret: "secret" });
    (client as any).sessions.set("session-token", {
      user: { id: "user-1" },
      accessToken: "access-token",
      accessTokenExpiresAt: Date.now() + 60_000,
      expiresAt: Date.now() + 60_000,
    });

    const result = await client.tokenApiRequest("runner_oidc_session=session-token", "/api-tokens/runner", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ label: "deploy", scopes: ["runs:dispatch"] }),
    });
    const payload = await result?.json();
    expect(fetchMock).toHaveBeenCalledOnce();
    expect(fetchMock.mock.calls[0][0]).toBeInstanceOf(URL);
    expect(payload).toEqual({
      path: "/api-tokens/runner",
      options: {
        method: "POST",
        headers: {
          authorization: "Bearer access-token",
          "content-type": "application/json",
          "x-auth-audience": "runner",
        },
        body: { label: "deploy", scopes: ["runs:dispatch"] },
      },
    });
  });

  it("clears sessions and rejects tampered or expired state", async () => {
    const client = new OidcClient({ providerUrl: "https://auth.test", clientId: "runner", clientSecret: "secret" });
    const state = (client as any).signState({
      verifier: "verifier",
      nonce: "nonce",
      returnTo: "/runs",
      expiresAt: Date.now() + 1000,
    });
    expect(() => (client as any).parseState(`${state.split(".")[0]}.tampered`)).toThrow(
      "OIDC login state is invalid or expired",
    );
    const expiredState = (client as any).signState({
      verifier: "v",
      nonce: "n",
      returnTo: "/runs",
      expiresAt: Date.now() - 1,
    });
    await expect(client.completeLogin("code", expiredState, "https://runner.test/auth/callback")).rejects.toThrow(
      "OIDC login state is invalid or expired",
    );
    (client as any).sessions.set("session-token", {
      user: { id: "user-1" },
      accessToken: "access-token",
      accessTokenExpiresAt: Date.now() + 60_000,
      expiresAt: Date.now() + 60_000,
    });
    expect(client.clearCookie("runner_oidc_session=session-token")).toContain("Max-Age=0");
    expect(client.userFromCookie("runner_oidc_session=session-token")).toBeUndefined();
  });
});
