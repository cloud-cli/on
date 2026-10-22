import { describe, expect, it, vi } from "vitest";
import { RequestAuthorizer } from "./authorization.js";
import { WebhookServer } from "./server.js";

const response = () => ({ writeHead: vi.fn().mockReturnThis(), end: vi.fn(), headersSent: false }) as any;
const principal = (overrides: Record<string, unknown> = {}) => ({
  subject: "user-1",
  kind: "human",
  platformRole: "user",
  platformCapabilities: [],
  disabled: false,
  ...overrides,
});
const request = (url: string, method = "GET", headers: Record<string, string> = {}) =>
  ({ url, method, headers: { host: "app.test", ...headers } }) as any;

describe("current IAM route authorization", () => {
  it("accepts pending subject invitations for the verified OIDC subject after login", async () => {
    const user = { id: "auth-agent-sub", name: "Automation Agent", email: undefined };
    const server = {
      oidc: {
        enabled: true,
        completeLogin: vi.fn(async () => ({ cookie: "app-session=opaque", returnTo: "/ui/runs" })),
        userFromCookie: vi.fn(() => user),
        setRole: vi.fn(),
      },
      oidcUsers: { upsert: vi.fn(async () => {}), role: vi.fn(async () => "user") },
      teams: { acceptSubjectInvitations: vi.fn(async () => {}) },
      oidcRedirectUri: vi.fn(() => "https://app.test/auth/callback"),
      isHttps: vi.fn(() => true),
    } as any;
    const res = response();

    await (WebhookServer.prototype as any).handleOidcCallback.call(
      server,
      request("/auth/callback"),
      res,
      new URL("https://app.test/auth/callback?code=auth-code&state=oidc-state"),
    );

    expect(server.oidcUsers.upsert).toHaveBeenCalledWith(user);
    expect(server.teams.acceptSubjectInvitations).toHaveBeenCalledWith("auth-agent-sub");
    expect(res.writeHead).toHaveBeenCalledWith(
      302,
      expect.objectContaining({ Location: "/ui/runs", "Set-Cookie": "app-session=opaque; Secure" }),
    );
  });

  it("binds API-key workspace access to its workspace and granted capabilities", async () => {
    const principals = {
      tokenPrincipal: vi.fn(async () => principal({ kind: "api-key" })),
      membership: vi.fn(async (team: string) =>
        team === "workspace-a" ? { role: "member", capabilities: ["runs:read"] } : null,
      ),
    } as any;
    const authorizer = new RequestAuthorizer(undefined, principals);
    const allowed = await authorizer.workspace(
      request("/api/v1/jobs", "GET", { authorization: "Bearer token", "x-team-id": "workspace-a" }),
      response(),
      "runs:read",
    );
    expect(allowed).toMatchObject({ teamId: "workspace-a", capabilities: ["runs:read"] });

    const denied = response();
    expect(
      await authorizer.workspace(
        request("/api/v1/jobs", "GET", { authorization: "Bearer token", "x-team-id": "workspace-b" }),
        denied,
        "runs:read",
      ),
    ).toBeNull();
    expect(principals.membership).toHaveBeenLastCalledWith("workspace-b", "user-1");
    expect(denied.writeHead).toHaveBeenCalledWith(404, expect.any(Object));

    const scopeDenied = response();
    await authorizer.workspace(
      request("/api/v1/jobs", "POST", { authorization: "Bearer token", "x-team-id": "workspace-a" }),
      scopeDenied,
      "runs:control",
    );
    expect(scopeDenied.writeHead).toHaveBeenCalledWith(403, expect.any(Object));
  });

  it("requires authentication and hides inaccessible workspace routes", async () => {
    const authorizer = new RequestAuthorizer(undefined, {
      tokenPrincipal: vi.fn(async () => null),
      membership: vi.fn(async () => null),
    } as any);
    const unauthenticated = response();
    expect(await authorizer.workspace(request("/api/v1/secrets"), unauthenticated, "secrets:read")).toBeNull();
    expect(unauthenticated.writeHead).toHaveBeenCalledWith(401, expect.any(Object));

    const inaccessible = response();
    const members = { tokenPrincipal: vi.fn(async () => principal()), membership: vi.fn(async () => null) } as any;
    expect(
      await new RequestAuthorizer(undefined, members).workspace(
        request("/api/v1/secrets", "GET", { authorization: "Bearer valid", "x-team-id": "private" }),
        inaccessible,
        "secrets:read",
      ),
    ).toBeNull();
    expect(inaccessible.writeHead).toHaveBeenCalledWith(404, expect.any(Object));
  });

  it("requires explicit platform capabilities for user-management operations", async () => {
    const authorizer = new RequestAuthorizer(undefined, {
      tokenPrincipal: vi.fn(async () => principal()),
    } as any);
    const denied = response();
    expect(
      await authorizer.platform(
        request("/api/users", "GET", { authorization: "Bearer user-token" }),
        denied,
        "users:manage",
      ),
    ).toBeNull();
    expect(denied.writeHead).toHaveBeenCalledWith(403, expect.any(Object));

    const admin = new RequestAuthorizer(undefined, {
      tokenPrincipal: vi.fn(async () => principal({ platformCapabilities: ["users:manage"] })),
    } as any);
    expect(
      await admin.platform(
        request("/api/users", "GET", { authorization: "Bearer admin-token" }),
        response(),
        "users:manage",
      ),
    ).toMatchObject({ principal: { subject: "user-1" }, source: "token" });
  });

  it("lists every workspace for an admin-scope bearer on the canonical workspace API", async () => {
    const workspaces = [
      { id: "alpha", name: "Alpha" },
      { id: "beta", name: "Beta" },
    ];
    const server = {
      authorizer: {
        authenticated: vi.fn(async () => ({ principal: principal(), source: "token" })),
        hasOidcAdmin: vi.fn(async () => true),
      },
      workflowsLoaded: Promise.resolve(),
      teams: { listAll: vi.fn(async () => workspaces) },
      principals: { workspaceListFor: vi.fn(async () => [{ id: "alpha" }]) },
    } as any;
    const res = response();

    await (WebhookServer.prototype as any).handleTeams.call(
      server,
      request("/api/workspaces", "GET", { authorization: "Bearer admin" }),
      res,
      new URL("http://app.test/api/workspaces"),
    );

    expect(server.teams.listAll).toHaveBeenCalledOnce();
    expect(server.principals.workspaceListFor).not.toHaveBeenCalled();
    expect(res.end).toHaveBeenCalledWith(JSON.stringify({ workspaces }));
  });

  it("allows admin-scope tokens to provision webhook URLs through the canonical workspace API", async () => {
    const registration = {
      id: "hook-1",
      provider: "github",
      createdAt: "now",
      token: "one-time-route-token",
      signingSecret: "one-time-signing-secret",
    };
    const server = {
      authorizer: {
        authenticated: vi.fn(async () => ({ principal: principal(), source: "token" })),
        hasOidcAdmin: vi.fn(async () => false),
        workspace: vi.fn(async () => ({ principal: principal(), source: "token", teamId: "unrelated" })),
      },
      workflowsLoaded: Promise.resolve(),
      teams: {},
      principals: { recordAudit: vi.fn(async () => {}) },
      workspaceWebhooks: { create: vi.fn(async () => registration) },
      readJson: vi.fn(async () => ({ provider: "github" })),
    } as any;
    const res = response();

    await (WebhookServer.prototype as any).handleTeams.call(
      server,
      request("/api/workspaces/unrelated/webhooks", "POST", { authorization: "Bearer admin" }),
      res,
      new URL("http://app.test/api/workspaces/unrelated/webhooks"),
    );

    expect(server.authorizer.workspace).toHaveBeenCalledWith(expect.anything(), res, "webhooks.manage", "unrelated");
    expect(server.workspaceWebhooks.create).toHaveBeenCalledWith("unrelated", "github");
    expect(server.principals.recordAudit).toHaveBeenCalledWith(
      expect.objectContaining({ action: "workspace.webhook.create", teamId: "unrelated", target: "hook-1" }),
    );
    expect(res.end.mock.calls[0][0]).toContain("one-time-signing-secret");
  });
});

describe("incoming workflow webhook dispatch", () => {
  it("queues the persisted workflow ID rather than the YAML definition ID", async () => {
    const queue = { enqueue: vi.fn(async () => 42) };
    const server = {
      preprocessors: new Map(),
      queue,
      events: { publish: vi.fn() },
    } as any;

    const jobs = await (WebhookServer.prototype as any).matchWorkflows.call(
      server,
      "github",
      { event: "push" },
      [
        {
          workflowId: "wf-docker-publish",
          revision: 3,
          definition: {
            id: "docker-publish",
            name: "Docker publish",
            on: { provider: "github" },
            tags: ["alpha"],
            steps: [{ id: "build", run: "echo build" }],
          },
        },
      ],
      {},
      "workspace-1",
    );

    expect(queue.enqueue).toHaveBeenCalledWith(
      "wf-docker-publish",
      3,
      { inputs: { event: "push" }, matrix: undefined },
      ["alpha"],
      "",
    );
    expect(jobs).toEqual([42]);
  });
});
