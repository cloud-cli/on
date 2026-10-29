import { describe, expect, it, vi } from "vitest";
import { RequestAuthorizer } from "./authorization.js";

const human = (subject = "human") => ({
  subject,
  kind: "human",
  platformRole: "user",
  platformCapabilities: [],
  disabled: false,
});
const request = (headers: Record<string, string> = {}, method = "GET", url = "/") => ({ headers, method, url }) as any;
const response = () => ({ headersSent: false, writeHead: vi.fn().mockReturnThis(), end: vi.fn() });
const setup = (overrides: any = {}) => {
  const oidc = {
    userFromCookie: vi.fn(),
    userFromAccessToken: vi.fn(),
    scopesForToken: vi.fn(async () => []),
    identityForToken: vi.fn(async () => null),
  };
  const principals = { principal: vi.fn(), tokenPrincipal: vi.fn(), membership: vi.fn(), ...overrides };
  return { auth: new RequestAuthorizer(oidc as any, principals as any), oidc, principals };
};
const error = (res: ReturnType<typeof response>) => JSON.parse(res.end.mock.calls.at(-1)?.[0] || "{}").error;

describe("RequestAuthorizer", () => {
  it("requires authentication and resolves a live session principal", async () => {
    const { auth, principals, oidc } = setup();
    expect(await auth.resolve(request())).toEqual({ status: 401, error: "Authentication required" });
    oidc.userFromCookie.mockReturnValue({ id: "alice" });
    principals.principal.mockResolvedValue(human("alice"));
    expect(await auth.resolve(request({ cookie: "sid" }))).toMatchObject({
      source: "session",
      principal: { subject: "alice" },
    });
    principals.principal.mockResolvedValue({ ...human("alice"), disabled: true });
    expect(await auth.resolve(request({ cookie: "sid" }))).toEqual({ status: 401, error: "Authentication required" });
  });

  it("resolves bearer principal tokens and provider access tokens", async () => {
    const { auth, principals, oidc } = setup();
    principals.tokenPrincipal.mockResolvedValue(human("token-user"));
    expect(await auth.resolve(request({ authorization: "Bearer opaque" }))).toMatchObject({
      source: "token",
      principal: { subject: "token-user" },
    });
    principals.tokenPrincipal.mockResolvedValue(null);
    oidc.userFromAccessToken.mockResolvedValue({ id: "provider-user" });
    principals.principal.mockResolvedValue(human("provider-user"));
    expect(await auth.resolve(request({ authorization: "Bearer provider" }))).toMatchObject({
      source: "token",
      principal: { subject: "provider-user" },
    });
    oidc.userFromAccessToken.mockResolvedValue(null);
    expect(await auth.resolve(request({ authorization: "Bearer revoked" }))).toEqual({
      status: 401,
      error: "Bearer credential is invalid or revoked",
    });
  });

  it("accepts active introspected opaque tokens by subject, but rejects inactive or subjectless tokens", async () => {
    const { auth, principals, oidc } = setup();
    principals.tokenPrincipal.mockResolvedValue(null);
    oidc.userFromAccessToken.mockResolvedValue(undefined);
    oidc.identityForToken.mockResolvedValue({ subject: "opaque-user", scopes: ["runs:read"] });
    principals.principal.mockResolvedValue(human("opaque-user"));
    await expect(auth.resolve(request({ authorization: "Bearer opaque" }))).resolves.toMatchObject({
      principal: { subject: "opaque-user" },
      source: "token",
    });
    oidc.identityForToken.mockResolvedValue(null);
    await expect(auth.resolve(request({ authorization: "Bearer opaque" }))).resolves.toMatchObject({ status: 401 });
  });

  it("rejects mismatched credentials without looking up the session principal", async () => {
    const { auth, principals, oidc } = setup();
    oidc.userFromCookie.mockReturnValue({ id: "alice" });
    principals.tokenPrincipal.mockResolvedValue(human("bob"));
    expect(await auth.resolve(request({ cookie: "sid", authorization: "Bearer token" }))).toMatchObject({
      status: 403,
    });
    expect(principals.principal).not.toHaveBeenCalled();
  });

  it("enforces same-origin only for session mutations", async () => {
    const { auth, oidc, principals } = setup();
    oidc.userFromCookie.mockReturnValue({ id: "alice" });
    principals.principal.mockResolvedValue(human());
    for (const origin of [undefined, "https://foreign.test"]) {
      const res = response();
      expect(
        await auth.authenticated(
          request({ cookie: "sid", host: "app.test", ...(origin ? { origin } : {}) }, "POST"),
          res as any,
        ),
      ).toBeNull();
      expect(res.writeHead).toHaveBeenCalledWith(403, expect.anything());
      expect(error(res)).toBe("Same-origin request required");
    }
    expect(
      await auth.authenticated(
        request({ cookie: "sid", host: "app.test", origin: "https://app.test" }, "POST"),
        response() as any,
      ),
    ).not.toBeNull();
    oidc.userFromCookie.mockReturnValue(undefined);
    principals.tokenPrincipal.mockResolvedValue(human("token"));
    expect(
      await auth.authenticated(request({ authorization: "Bearer token" }, "POST"), response() as any),
    ).not.toBeNull();
  });

  it("restricts human-only operations", async () => {
    const { auth, oidc, principals } = setup();
    oidc.userFromCookie.mockReturnValue({ id: "alice" });
    principals.principal.mockResolvedValue({ ...human(), kind: "system" });
    const res = response();
    expect(await auth.human(request({ cookie: "sid" }), res as any)).toBeNull();
    expect(res.writeHead).toHaveBeenCalledWith(403, expect.anything());
    principals.principal.mockResolvedValue(human());
    expect(await auth.human(request({ cookie: "sid" }), response() as any)).not.toBeNull();
  });

  it("checks workspace membership/capabilities and team id sources", async () => {
    const { auth, oidc, principals } = setup();
    oidc.userFromCookie.mockReturnValue({ id: "alice" });
    principals.principal.mockResolvedValue(human());
    let res = response();
    expect(await auth.workspace(request({ cookie: "sid" }), res as any, "workflows.view")).toBeNull();
    expect(res.writeHead).toHaveBeenCalledWith(400, expect.anything());
    expect(error(res)).toBe("X-Workspace-ID is required");
    principals.membership.mockResolvedValue(null);
    res = response();
    expect(
      await auth.workspace(request({ cookie: "sid", "x-workspace-id": "t" }), res as any, "workflows.view"),
    ).toBeNull();
    expect(res.writeHead).toHaveBeenCalledWith(404, expect.anything());
    expect(error(res)).toBe("Workspace not found");
    principals.membership.mockResolvedValue({ role: "viewer", capabilities: [] });
    res = response();
    expect(
      await auth.workspace(request({ cookie: "sid", "x-workspace-id": "t" }), res as any, "workflows.view"),
    ).toBeNull();
    expect(error(res)).toContain("workflows.view");
    principals.membership.mockResolvedValue({ role: "viewer", capabilities: ["workflows.view"] });
    expect(
      await auth.workspace(
        request({ cookie: "sid", "x-workspace-id": "header" }),
        response() as any,
        "workflows.view",
        "override",
      ),
    ).toMatchObject({ teamId: "override", role: "viewer", capabilities: ["workflows.view"] });
    expect(
      await auth.workspace(request({ cookie: "sid" }, "GET", "/?teamId=query"), response() as any, "workflows.view"),
    ).toMatchObject({ teamId: "query" });
  });

  it("checks platform single/any capabilities and translates legacy scopes", async () => {
    const { auth, oidc, principals } = setup();
    oidc.userFromCookie.mockReturnValue({ id: "alice" });
    principals.principal.mockResolvedValue(human());
    const res = response();
    expect(await auth.platform(request({ cookie: "sid" }), res as any, "platform.runners.view")).toBeNull();
    expect(res.writeHead).toHaveBeenCalledWith(403, expect.anything());
    principals.principal.mockResolvedValue({ ...human(), platformCapabilities: ["platform.runners.view"] });
    expect(await auth.platform(request({ cookie: "sid" }), response() as any, "platform.runners.view")).not.toBeNull();
    expect(
      await auth.platformAny(request({ cookie: "sid" }), response() as any, [
        "platform.users.manage",
        "platform.runners.view",
      ]),
    ).not.toBeNull();
    principals.membership.mockResolvedValue({ role: "viewer", capabilities: ["workflows.view"] });
    expect(
      await auth.legacyScope(request({ cookie: "sid", "x-workspace-id": "t" }), response() as any, "workflows:read"),
    ).toMatchObject({ teamId: "t" });
    expect(await auth.legacyScope(request({ cookie: "sid" }), response() as any, "workers:read")).not.toBeNull();
    const unknown = response();
    expect(await auth.legacyScope(request({ cookie: "sid" }), unknown as any, "unknown")).toBeNull();
    expect(unknown.writeHead).toHaveBeenCalledWith(403, expect.anything());
  });

  it("grants platform-wide workspace and platform capabilities only to an active OIDC admin token", async () => {
    const { auth, oidc, principals } = setup();
    const tokenRequest = request({ authorization: "Bearer oidc-admin", "x-workspace-id": "unrelated-workspace" });
    oidc.userFromAccessToken.mockResolvedValue({ id: "automation-user" });
    oidc.scopesForToken.mockResolvedValue(["openid", "admin"]);
    oidc.identityForToken.mockResolvedValue({ subject: "automation-user", scopes: ["openid", "admin"] });
    principals.tokenPrincipal.mockResolvedValue(null);
    principals.principal.mockResolvedValue(human("automation-user"));
    principals.membership.mockResolvedValue(null);

    await expect(auth.workspace(tokenRequest, response() as any, "secrets.edit")).resolves.toMatchObject({
      teamId: "unrelated-workspace",
      role: "admin",
      capabilities: expect.arrayContaining(["secrets.edit", "members.manage"]),
    });
    await expect(auth.platform(tokenRequest, response() as any, "platform.workspaces.delete")).resolves.toMatchObject({
      principal: { subject: "automation-user" },
    });
    await expect(
      auth.platformAny(tokenRequest, response() as any, ["platform.runners.manage", "platform.policy.manage"]),
    ).resolves.toMatchObject({ principal: { subject: "automation-user" } });
    expect(principals.membership).not.toHaveBeenCalled();
  });

  it("does not elevate inactive, non-admin, API-key, or disabled credentials", async () => {
    const { auth, oidc, principals } = setup();
    const tokenRequest = request({ authorization: "Bearer token", "x-workspace-id": "workspace" });
    oidc.userFromAccessToken.mockResolvedValue({ id: "automation-user" });
    principals.tokenPrincipal.mockResolvedValue(null);
    principals.principal.mockResolvedValue(human("automation-user"));
    principals.membership.mockResolvedValue(null);

    oidc.scopesForToken.mockResolvedValue(["openid", "profile"]);
    oidc.identityForToken.mockResolvedValue({ subject: "automation-user", scopes: ["openid", "profile"] });
    const missingScope = response();
    await expect(auth.workspace(tokenRequest, missingScope as any, "secrets.manage")).resolves.toBeNull();
    expect(missingScope.writeHead).toHaveBeenCalledWith(404, expect.anything());

    oidc.scopesForToken.mockResolvedValue(null);
    oidc.identityForToken.mockResolvedValue(null);
    const inactive = response();
    await expect(auth.platform(tokenRequest, inactive as any, "platform.users.manage")).resolves.toBeNull();
    expect(inactive.writeHead).toHaveBeenCalledWith(403, expect.anything());

    oidc.scopesForToken.mockResolvedValue(["admin"]);
    oidc.identityForToken.mockResolvedValue({ subject: "automation-user", scopes: ["admin"] });
    principals.tokenPrincipal.mockResolvedValue(human("automation-user"));
    oidc.scopesForToken.mockResolvedValue([]);
    oidc.identityForToken.mockResolvedValue({ subject: "automation-user", scopes: [] });
    const apiKey = response();
    await expect(auth.platform(tokenRequest, apiKey as any, "platform.users.manage")).resolves.toBeNull();
    expect(apiKey.writeHead).toHaveBeenCalledWith(403, expect.anything());

    principals.tokenPrincipal.mockResolvedValue(null);
    principals.principal.mockResolvedValue({ ...human("automation-user"), disabled: true });
    const disabled = response();
    await expect(auth.platform(tokenRequest, disabled as any, "platform.users.manage")).resolves.toBeNull();
    expect(disabled.writeHead).toHaveBeenCalledWith(401, expect.anything());
  });

  it("rejects a mismatched cookie identity even when the bearer has admin scope", async () => {
    const { auth, oidc, principals } = setup();
    oidc.userFromCookie.mockReturnValue({ id: "browser-user" });
    oidc.userFromAccessToken.mockResolvedValue({ id: "automation-user" });
    oidc.scopesForToken.mockResolvedValue(["admin"]);
    oidc.identityForToken.mockResolvedValue({ subject: "automation-user", scopes: ["admin"] });
    principals.principal.mockResolvedValue(human("automation-user"));
    const res = response();

    await expect(
      auth.workspace(
        request({ cookie: "sid", authorization: "Bearer oidc-admin", "x-workspace-id": "workspace" }),
        res as any,
        "secrets.manage",
      ),
    ).resolves.toBeNull();
    expect(res.writeHead).toHaveBeenCalledWith(403, expect.anything());
    expect(error(res)).toContain("different principals");
  });
});
