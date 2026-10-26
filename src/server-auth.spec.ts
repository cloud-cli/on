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
        publish: vi.fn(async () => ({
          id: "event-1",
          type: "workflow.run.requested",
          source: "api/workflows/run",
          data: { workflowId: "workflow-1", revision: 1, inputsCiphertext: "cipher" },
        })),
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
