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
  it("routes the documented versioned connector ingress URL to the connector handler", async () => {
    const connector = {
      id: "normalize",
      workspaceId: "team-a",
      name: "Normalize",
      sourceYaml: "run: |\\n  emit('ok', {})",
      version: 1,
    };
    const server = {
      workflowsLoaded: Promise.resolve(),
      connectors: { lookupByToken: vi.fn(async () => connector) },
      handleConnectorWebhook: vi.fn(async (_connector, _req, res) => res.writeHead(202).end("accepted")),
    };
    const res = response();

    await (WebhookServer.prototype as any).handleRequest.call(
      server,
      request("/api/v1/webhooks/connectors/one-time-route-token", "POST"),
      res,
    );

    expect(server.connectors.lookupByToken).toHaveBeenCalledWith("one-time-route-token");
    expect(server.handleConnectorWebhook).toHaveBeenCalledWith(connector, expect.anything(), res);
    expect(res.writeHead).toHaveBeenCalledWith(202);
    expect(res.end).toHaveBeenCalledWith("accepted");
  });

  it.each([
    "/ui/channels",
    "/ui/workspaces/team-a/channels",
    "/ui/workspaces/team-a/channels/stream-a",
    "/ui/workspaces/team-a/connectors",
    "/ui/workspaces/team-a/connectors/connector-a",
    "/ui/workspaces/team-a/workflows",
    "/ui/workspaces/team-a/workflows/build-1",
    "/ui/workspaces/team-a/runs/events",
    "/ui/workspaces/team-a/invocations/invocation-a",
  ])("requires sign-in and serves the shell on refresh for %s", async (path) => {
    const renderAppShell = vi.fn((res) => res.writeHead(200).end("shell"));
    const server = { oidc: { enabled: true, userFromCookie: vi.fn(() => null) }, renderAppShell };
    const unauthenticated = response();
    await (WebhookServer.prototype as any).handleRequest.call(server, request(`${path}?revision=2`), unauthenticated);
    expect(unauthenticated.writeHead).toHaveBeenCalledWith(302, {
      Location: `/auth/login?url=${encodeURIComponent(`${path}?revision=2`)}`,
    });
    expect(renderAppShell).not.toHaveBeenCalled();

    server.oidc.userFromCookie.mockReturnValue({ subject: "user-1" } as any);
    const authenticated = response();
    await (WebhookServer.prototype as any).handleRequest.call(server, request(path), authenticated);
    expect(renderAppShell).toHaveBeenCalledWith(authenticated);
    expect(authenticated.writeHead).toHaveBeenCalledWith(200);
  });

  it("serves recipe revocation status only through an authorized active lease", async () => {
    const server = {
      workflowsLoaded: Promise.resolve(),
      authenticateRunner: vi.fn(async () => ({ runnerId: "runner-1" })),
      queue: {
        getLeasedJob: vi.fn(async () => ({ id: 7, status: "running", lease_completed: 0 })),
        isRecipeVersionRevoked: vi.fn(async () => true),
      },
    };
    const res = response();
    await (WebhookServer.prototype as any).handleRequest.call(
      server,
      request(
        "/api/v1/runner/leases/lease-1/recipe-version-revocation?namespace=team-a&slug=release-1&version=2",
        "GET",
        { authorization: "Bearer runner", "x-runner-lease-token": "lease-token" },
      ),
      res,
    );
    expect(server.queue.getLeasedJob).toHaveBeenCalledWith("lease-1", "runner-1", expect.any(String));
    expect(server.queue.isRecipeVersionRevoked).toHaveBeenCalledWith("team-a", "release-1", 2);
    expect(JSON.parse(res.end.mock.calls[0][0])).toEqual({ revoked: true });

    const invalidResponse = response();
    await (WebhookServer.prototype as any).handleRequest.call(
      server,
      request("/api/v1/runner/leases/lease-1/recipe-version-revocation?namespace=../x&slug=release-1&version=2"),
      invalidResponse,
    );
    expect(invalidResponse.writeHead).toHaveBeenCalledWith(400, expect.any(Object));
    expect(server.queue.isRecipeVersionRevoked).toHaveBeenCalledOnce();
  });

  it.each([
    ["missing", false],
    ["revoked", false],
    ["active", true],
  ])("requires an active grant for agent workflow runs (%s)", async (_label, granted) => {
    const server = {
      requireWorkspaceCapability: vi.fn(async () => ({
        principal: { subject: "agent:build", kind: "agent" },
        teamId: "team-1",
        capabilities: ["runs.dispatch"],
      })),
      workflowsLoaded: Promise.resolve(),
      readJson: vi.fn(async () => null),
      workflows: {
        getForTeam: vi.fn(async () => ({ id: "workflow-1" })),
        latestRevision: vi.fn(async () => ({ revision: 1 })),
        getRevision: vi.fn(async () => ({ tags: [], steps: [{ run: "true" }] })),
      },
      agentWorkflowGrantRepository: { has: vi.fn(async () => granted) },
      queue: { enqueueDispatch: vi.fn(async () => 10) },
      workflowRunAdmissions: { claimNext: vi.fn(), finish: vi.fn() },
      domainEventRepository: {
        getByIdempotencyKey: vi.fn(async () => null),
        publish: vi.fn(async (_teamId: string, event: any) => ({ id: "event-1", ...event })),
      },
      secretRepository: {
        encryptValue: vi.fn((value: string) => value),
        decryptValue: vi.fn(() => JSON.stringify({ trigger: { type: "manual", source: "api" } })),
      },
      events: { publish: vi.fn() },
    };
    const runRequest = request("/api/v1/workflows/workflow-1/run", "POST", { "idempotency-key": "retry-1" });
    const res = response();
    await (WebhookServer.prototype as any).handleWorkflowRun.call(server, runRequest, res, "workflow-1");
    expect(server.agentWorkflowGrantRepository.has).toHaveBeenCalledWith("team-1", "agent:build", "workflow-1");
    if (granted) {
      expect(server.queue.enqueueDispatch).not.toHaveBeenCalled();
      expect(server.domainEventRepository.publish).toHaveBeenCalledOnce();
      expect(JSON.parse(res.end.mock.calls[0][0])).toMatchObject({
        eventId: "event-1",
        invocationId: expect.any(String),
        accepted: true,
        admissionStatus: "pending",
        jobs: [],
      });

      const acceptedEvent = await server.domainEventRepository.publish.mock.results[0].value;
      server.domainEventRepository.getByIdempotencyKey.mockResolvedValueOnce(acceptedEvent);
      const retryResponse = response();
      await (WebhookServer.prototype as any).handleWorkflowRun.call(server, runRequest, retryResponse, "workflow-1");
      expect(server.domainEventRepository.publish).toHaveBeenCalledOnce();
      expect(JSON.parse(retryResponse.end.mock.calls[0][0])).toMatchObject({
        eventId: "event-1",
        invocationId: JSON.parse(res.end.mock.calls[0][0]).invocationId,
        accepted: true,
        admissionStatus: "pending",
        jobs: [],
      });

      server.domainEventRepository.getByIdempotencyKey.mockResolvedValueOnce(acceptedEvent);
      server.readJson.mockResolvedValueOnce({ inputs: { different: true } });
      const conflictResponse = response();
      await (WebhookServer.prototype as any).handleWorkflowRun.call(server, runRequest, conflictResponse, "workflow-1");
      expect(conflictResponse.writeHead).toHaveBeenCalledWith(409, expect.any(Object));
      expect(server.domainEventRepository.publish).toHaveBeenCalledOnce();
    } else {
      expect(res.writeHead).toHaveBeenCalledWith(403, expect.any(Object));
      expect(server.queue.enqueueDispatch).not.toHaveBeenCalled();
      expect(server.domainEventRepository.publish).not.toHaveBeenCalled();
    }
  });

  it("hides diagnostic inputs unless the principal has runs.inputs", async () => {
    const makeServer = (capabilities: string[]) => ({
      requireWorkspaceCapability: vi.fn(async () => ({ teamId: "team-1", capabilities })),
      queue: {
        getJobForTeam: vi.fn(async () => ({
          id: 1,
          report: JSON.stringify({ inputs: { customer: "private" }, steps: [] }),
          workflow_id: "workflow-1",
          workflow_revision: 1,
          status: "success",
        })),
        getJobLogs: vi.fn(async () => ({})),
      },
      workflows: {
        getRevision: vi.fn(async () => ({})),
        getRevisionSnapshot: vi.fn(async () => null),
      },
      currentSecrets: vi.fn(async () => ({})),
      redactStructured: (value: unknown) => value,
      redact: (value: unknown) => value,
    });
    const logsOnly = makeServer(["runs.logs"]);
    const hiddenResponse = response();
    await (WebhookServer.prototype as any).handleDiagnostics.call(
      logsOnly,
      request("/api/runs/1/diagnostics"),
      hiddenResponse,
      "1",
    );
    const hidden = JSON.parse(hiddenResponse.end.mock.calls[0][0]);
    expect(hidden).not.toHaveProperty("inputs");

    const inputReader = makeServer(["runs.logs", "runs.inputs"]);
    const visibleResponse = response();
    await (WebhookServer.prototype as any).handleDiagnostics.call(
      inputReader,
      request("/api/runs/1/diagnostics"),
      visibleResponse,
      "1",
    );
    expect(JSON.parse(visibleResponse.end.mock.calls[0][0]).inputs).toEqual({
      customer: "private",
    });
  });

  it("blocks dashboard filters from actors without runs.inputs", async () => {
    const server = {
      requireWorkspaceCapability: vi.fn(async () => ({
        teamId: "team-1",
        capabilities: ["runs.view"],
      })),
      queue: { listJobsForTeam: vi.fn() },
    };
    const res = response();
    await (WebhookServer.prototype as any).renderDashboardJobs.call(
      server,
      request("/api/jobs"),
      res,
      50,
      undefined,
      undefined,
      "region:prod",
    );
    expect(res.writeHead).toHaveBeenCalledWith(403, expect.any(Object));
    expect(server.queue.listJobsForTeam).not.toHaveBeenCalled();
  });

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
      request("/api/v1/jobs", "GET", { authorization: "Bearer token", "x-workspace-id": "workspace-a" }),
      response(),
      "runs:read",
    );
    expect(allowed).toMatchObject({ teamId: "workspace-a", capabilities: ["runs:read"] });

    const denied = response();
    expect(
      await authorizer.workspace(
        request("/api/v1/jobs", "GET", { authorization: "Bearer token", "x-workspace-id": "workspace-b" }),
        denied,
        "runs:read",
      ),
    ).toBeNull();
    expect(principals.membership).toHaveBeenLastCalledWith("workspace-b", "user-1");
    expect(denied.writeHead).toHaveBeenCalledWith(404, expect.any(Object));

    const scopeDenied = response();
    await authorizer.workspace(
      request("/api/v1/jobs", "POST", { authorization: "Bearer token", "x-workspace-id": "workspace-a" }),
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
        request("/api/v1/secrets", "GET", { authorization: "Bearer valid", "x-workspace-id": "private" }),
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

  it("creates a workspace-scoped connector and returns its webhook address once", async () => {
    const record = {
      id: "normalize",
      workspaceId: "unrelated",
      name: "Normalize",
      sourceYaml: "run: |\n  emit('sample.received', inputs)",
      version: 1,
      enabled: true,
      createdAt: "now",
      updatedAt: "now",
      token: "one-time-route-token",
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
      connectors: { createForWorkspace: vi.fn(async () => record) },
      readJson: vi.fn(async () => ({ id: "normalize", name: "Normalize", sourceYaml: record.sourceYaml })),
    } as any;
    const res = response();

    await (WebhookServer.prototype as any).handleTeams.call(
      server,
      request("/api/workspaces/unrelated/connectors", "POST", { authorization: "Bearer admin" }),
      res,
      new URL("http://app.test/api/workspaces/unrelated/connectors"),
    );

    expect(server.authorizer.workspace).toHaveBeenCalledWith(expect.anything(), res, "webhooks.manage", "unrelated");
    expect(server.connectors.createForWorkspace).toHaveBeenCalledWith(
      "unrelated",
      "normalize",
      "Normalize",
      record.sourceYaml,
    );
    expect(server.principals.recordAudit).toHaveBeenCalledWith(
      expect.objectContaining({ action: "connector.create", teamId: "unrelated", target: "normalize" }),
    );
    expect(res.end.mock.calls[0][0]).toContain("/api/v1/webhooks/connectors/one-time-route-token");
    expect(JSON.parse(res.end.mock.calls[0][0]).connector).not.toHaveProperty("token");
  });

  it("rotates a connector signing secret only with workspace manage capability and disables caching", async () => {
    const connector = {
      id: "normalize",
      workspaceId: "workspace-a",
      name: "Normalize",
      sourceYaml: "yaml",
      version: 1,
      enabled: true,
      published: true,
      hasSigningSecret: true,
    };
    const server = {
      authorizer: {
        authenticated: vi.fn(async () => ({ principal: principal(), source: "token" })),
        workspace: vi.fn(async () => ({ principal: principal(), source: "token", teamId: "workspace-a" })),
      },
      principals: { recordAudit: vi.fn(async () => {}) },
      connectors: {
        getForWorkspace: vi.fn(async () => connector),
        rotateSigningSecret: vi.fn(async () => ({ connector, secret: "whsec_new-secret" })),
      },
    } as any;
    const res = response();

    await (WebhookServer.prototype as any).handleTeams.call(
      server,
      request("/api/workspaces/workspace-a/connectors/normalize/signing-secret", "POST"),
      res,
      new URL("http://app.test/api/workspaces/workspace-a/connectors/normalize/signing-secret"),
    );

    expect(server.authorizer.workspace).toHaveBeenCalledWith(expect.anything(), res, "webhooks.manage", "workspace-a");
    expect(server.connectors.rotateSigningSecret).toHaveBeenCalledWith("workspace-a", "normalize");
    expect(server.principals.recordAudit).toHaveBeenCalledWith(
      expect.objectContaining({
        action: "connector.signing-secret.rotate",
        target: "normalize",
        teamId: "workspace-a",
      }),
    );
    expect(res.writeHead).toHaveBeenCalledWith(200, expect.objectContaining({ "Cache-Control": "no-store" }));
    expect(JSON.parse(res.end.mock.calls[0][0])).toEqual({ connector, signingSecret: "whsec_new-secret" });
  });

  it("records a rejected input decision durably and reuses it for an idempotent retry", async () => {
    const domainEventRepository = {
      getByIdempotencyKey: vi.fn(async () => null),
      publish: vi.fn(async (_teamId: string, event: any) => ({ id: "request-event-1", ...event })),
    };
    const workflowRunAdmissions = { persistTerminal: vi.fn(async () => {}) };
    const server = {
      requireWorkspaceCapability: vi.fn(async () => ({
        teamId: "team-a",
        principal: { subject: "user-1", kind: "human" },
        capabilities: ["runs.dispatch"],
      })),
      readJson: vi.fn(async () => ({ inputs: { foo: "bar" } })),
      workflowsLoaded: Promise.resolve(),
      workflows: {
        getForTeam: vi.fn(async () => ({ id: "workflow-1" })),
        latestRevision: vi.fn(async () => ({ revision: 1 })),
        getRevision: vi.fn(async () => ({ tags: ["${("], steps: [] })),
      },
      agentWorkflowGrantRepository: { has: vi.fn(async () => true) },
      domainEventRepository,
      workflowRunAdmissions,
      secretRepository: {
        encryptValue: vi.fn((value: string) => `encrypted:${value}`),
        decryptValue: vi.fn((value: string) => value.replace(/^encrypted:/, "")),
      },
    };
    const req = request("/api/v1/workflows/workflow-1/run", "POST", { "idempotency-key": "reject-1" });
    const first = response();
    await (WebhookServer.prototype as any).handleWorkflowRun.call(server, req, first, "workflow-1");
    const firstBody = JSON.parse(first.end.mock.calls[0][0]);
    expect(first.writeHead).toHaveBeenCalledWith(400, expect.any(Object));
    expect(firstBody).toMatchObject({
      eventId: "request-event-1",
      invocationId: expect.any(String),
      admissionOutcome: "rejected",
    });
    expect(firstBody.invocationId).not.toBe(firstBody.eventId);
    expect(domainEventRepository.publish).toHaveBeenCalledOnce();
    expect(workflowRunAdmissions.persistTerminal).toHaveBeenCalledWith(
      expect.objectContaining({ eventId: "request-event-1", teamId: "team-a", index: -1 }),
      "failed",
      "invalid_inputs",
      "rejected",
    );

    const event = await domainEventRepository.publish.mock.results[0].value;
    domainEventRepository.getByIdempotencyKey.mockResolvedValueOnce(event);
    const retry = response();
    await (WebhookServer.prototype as any).handleWorkflowRun.call(server, req, retry, "workflow-1");
    expect(domainEventRepository.publish).toHaveBeenCalledOnce();
    expect(JSON.parse(retry.end.mock.calls[0][0])).toMatchObject({
      eventId: firstBody.eventId,
      invocationId: firstBody.invocationId,
      admissionOutcome: "rejected",
    });
  });
});
