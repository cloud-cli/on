import { afterEach, describe, expect, it, vi } from "vitest";
import { OidcClient } from "./oidc.js";

describe("OIDC client", () => {
  afterEach(() => vi.restoreAllMocks());

  it("performs PKCE login and creates a session from userinfo", async () => {
    const fetchMock = vi.spyOn(globalThis, "fetch").mockImplementation(async (input) => {
      const url = String(input);
      if (url.endsWith("/node.mjs"))
        return new Response(
          `
        export function createAuthClient() {
          return {
            createAuthorizationRequest({ redirectUri, scope }) {
              return { url: 'https://auth.test/authorize?response_type=code&code_challenge_method=S256&scope=' + encodeURIComponent(scope) + '&redirect_uri=' + encodeURIComponent(redirectUri), codeVerifier: 'verifier' };
            },
            async exchangeCode() { return { access_token: 'access-token', expires_in: 900 }; },
            async getProfile() { return { sub: 'user-1', preferred_username: 'ada', email: 'ada@example.test', picture: 'https://auth.test/ada.png' }; },
            async introspectToken() { return { active: true, scope: 'logs:read runs:dispatch' }; },
          };
        }
      `,
          { status: 200 },
        );
      throw new Error(`Unexpected request: ${url}`);
    });
    const client = new OidcClient({ providerUrl: "https://auth.test", clientId: "runner", clientSecret: "secret" });

    const loginUrl = await client.loginUrl("https://runner.test/auth/callback", "/runs/42");
    const state = new URL(loginUrl).searchParams.get("state");
    expect(new URL(loginUrl).searchParams.get("code_challenge_method")).toBe("S256");
    expect(new URL(loginUrl).searchParams.get("scope")).toBe("openid profile email");

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
});
