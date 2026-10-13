import { afterEach, describe, expect, it, vi } from "vitest";
import crypto from "node:crypto";
import { OidcClient } from "./oidc.js";

describe("OIDC client - internal logic", () => {
  afterEach(() => {
    vi.useRealTimers();
    vi.resetAllMocks();
  });

  it("signs and parses state correctly", () => {
    const client = new OidcClient({ providerUrl: "https://auth.test", clientId: "runner", clientSecret: "secret" });
    const state = (client as any).signState({
      verifier: "test-verifier",
      nonce: "test-nonce",
      returnTo: "/runs/42",
      expiresAt: Date.now() + 10 * 60 * 1000,
    });
    expect(state).toContain(".");
    const parsed = (client as any).parseState(state);
    expect(parsed.verifier).toBe("test-verifier");
    expect(parsed.returnTo).toBe("/runs/42");
    expect(parsed.expiresAt).toBeGreaterThan(Date.now());
  });

  it("rejects tampered state", () => {
    const client = new OidcClient({ providerUrl: "https://auth.test", clientId: "runner", clientSecret: "secret" });
    const state = (client as any).signState({
      verifier: "test-verifier",
      nonce: "test-nonce",
      returnTo: "/runs/42",
      expiresAt: Date.now() + 10 * 60 * 1000,
    });
    const [payload, signature] = state.split(".");
    const tampered = `${payload}.invalidsignature`;
    expect(() => (client as any).parseState(tampered)).toThrow("OIDC login state is invalid or expired");
  });

  it("rejects expired state", () => {
    const client = new OidcClient({ providerUrl: "https://auth.test", clientId: "runner", clientSecret: "secret" });
    const state = (client as any).signState({
      verifier: "test-verifier",
      nonce: "test-nonce",
      returnTo: "/runs/42",
      expiresAt: Date.now() - 1000,
    });
    expect(() => (client as any).parseState(state)).toThrow("OIDC login state is invalid or expired");
  });

  it("manages sessions and roles", () => {
    const client = new OidcClient({ providerUrl: "https://auth.test", clientId: "runner", clientSecret: "secret" });
    const sessionToken = "test-session-token";
    const now = Date.now();
    (client as any).sessions.set(sessionToken, {
      user: { id: "user-1", name: "Test User", email: "test@example.com" },
      role: "user",
      tokens: {
        access_token: "access-token",
        refresh_token: "refresh-token",
        expires_at: Math.floor((now + 3600_000) / 1000),
      },
      expiresAt: now + 8 * 60 * 60 * 1000,
    });

    expect(client.userFromCookie(`runner_oidc_session=${sessionToken}`)).toEqual({
      id: "user-1",
      name: "Test User",
      email: "test@example.com",
    });
    expect(client.roleFromCookie(`runner_oidc_session=${sessionToken}`)).toBe("user");

    client.setRole(`runner_oidc_session=${sessionToken}`, "admin");
    expect(client.roleFromCookie(`runner_oidc_session=${sessionToken}`)).toBe("admin");

    client.setRoleForUser("user-1", "user");
    expect(client.roleFromCookie(`runner_oidc_session=${sessionToken}`)).toBe("user");
  });

  it("clears cookie and session", () => {
    const client = new OidcClient({ providerUrl: "https://auth.test", clientId: "runner", clientSecret: "secret" });
    const sessionToken = "test-session-token";
    const now = Date.now();
    (client as any).sessions.set(sessionToken, {
      user: { id: "user-1" },
      tokens: {
        access_token: "access-token",
        refresh_token: "refresh-token",
        expires_at: Math.floor((now + 3600_000) / 1000),
      },
      expiresAt: now + 8 * 60 * 60 * 1000,
    });

    expect(client.userFromCookie(`runner_oidc_session=${sessionToken}`)).toBeTruthy();
    const clearedCookie = client.clearCookie(`runner_oidc_session=${sessionToken}`);
    expect(clearedCookie).toContain("Max-Age=0");
    expect(client.userFromCookie(`runner_oidc_session=${sessionToken}`)).toBeUndefined();
  });

  it("prunes expired sessions", () => {
    const client = new OidcClient({ providerUrl: "https://auth.test", clientId: "runner", clientSecret: "secret" });
    const now = Date.now();
    (client as any).sessions.set("expired", {
      user: { id: "user-1" },
      tokens: {
        access_token: "access-token",
        refresh_token: "refresh-token",
        expires_at: Math.floor((now - 1000) / 1000),
      },
      expiresAt: now - 1000,
    });
    (client as any).sessions.set("valid", {
      user: { id: "user-2" },
      tokens: {
        access_token: "access-token",
        refresh_token: "refresh-token",
        expires_at: Math.floor((now + 3600_000) / 1000),
      },
      expiresAt: now + 3600_000,
    });

    client.clearCookie("runner_oidc_session=expired");
    expect(client.userFromCookie("runner_oidc_session=expired")).toBeUndefined();
    expect(client.userFromCookie("runner_oidc_session=valid")).toBeTruthy();
  });

  it("normalizes issuer URL", () => {
    const client = new OidcClient({ providerUrl: "https://auth.test/", clientId: "runner", clientSecret: "secret" });
    expect(client.providerUrl).toBe("https://auth.test");
  });
});

describe("OIDC client - token refresh logic", () => {
  afterEach(() => {
    vi.useRealTimers();
    vi.resetAllMocks();
  });

  it("returns valid access token without refresh when not expiring soon", async () => {
    const client = new OidcClient({ providerUrl: "https://auth.test", clientId: "runner", clientSecret: "secret" });
    const sessionToken = "test-session-token";
    const now = Date.now();
    (client as any).sessions.set(sessionToken, {
      user: { id: "user-1" },
      tokens: {
        access_token: "valid-access-token",
        refresh_token: "refresh-token",
        expires_at: Math.floor((now + 3600_000) / 1000),
      },
      expiresAt: now + 8 * 60 * 60 * 1000,
    });

    const result = await client.accessTokenFromCookie(`runner_oidc_session=test-session-token`);
    expect(result).toEqual({ accessToken: "valid-access-token", expiresAt: expect.any(Number) });
  });

  it("returns undefined when no session exists", async () => {
    const client = new OidcClient({ providerUrl: "https://auth.test", clientId: "runner", clientSecret: "secret" });
    const result = await client.accessTokenFromCookie("runner_oidc_session=nonexistent");
    expect(result).toBeUndefined();
  });

  it("returns undefined when session is expired", async () => {
    const client = new OidcClient({ providerUrl: "https://auth.test", clientId: "runner", clientSecret: "secret" });
    const sessionToken = "expired-session";
    const now = Date.now();
    (client as any).sessions.set(sessionToken, {
      user: { id: "user-1" },
      tokens: {
        access_token: "expired-token",
        refresh_token: "refresh-token",
        expires_at: Math.floor((now - 1000) / 1000),
      },
      expiresAt: now - 1000,
    });

    const result = await client.accessTokenFromCookie(`runner_oidc_session=${sessionToken}`);
    expect(result).toBeUndefined();
  });
});
