import { describe, expect, it, vi } from "vitest";
import { WebhookServer } from "./server.js";
import db from "./db-client.js";

type TestResponse = {
  writeHead: ReturnType<typeof vi.fn>;
  end: ReturnType<typeof vi.fn>;
};

function invokeRequireAdmin({
  authenticated = false,
  admin = false,
  method = "GET",
  url = "/settings/workflows",
} = {}) {
  const response: TestResponse = {
    writeHead: vi.fn().mockReturnThis(),
    end: vi.fn(),
  };
  const server = {
    isAdmin: () => admin,
    oidc: { userFromCookie: () => (authenticated ? { id: "user-1" } : undefined) },
  };
  const request = { method, url, headers: { cookie: authenticated ? "runner_oidc_session=session" : undefined } };

  const allowed = (WebhookServer.prototype as any).requireAdmin.call(server, request, response);

  return { allowed, response };
}

describe("browser admin-route authorization", () => {
  it("sends authenticated non-admin OIDC users to their useful settings page", () => {
    const { allowed, response } = invokeRequireAdmin({ authenticated: true });

    expect(allowed).toBe(false);
    expect(response.writeHead).toHaveBeenCalledWith(302, { Location: "/ui/settings" });
    expect(response.end).toHaveBeenCalledOnce();
  });

  it("redirects signed-out visitors to sign-in with the original route and query", () => {
    const { allowed, response } = invokeRequireAdmin({ url: "/settings/workflows/build?revision=3" });

    expect(allowed).toBe(false);
    expect(response.writeHead).toHaveBeenCalledWith(302, {
      Location: "/auth/login?url=%2Fsettings%2Fworkflows%2Fbuild%3Frevision%3D3",
    });
  });

  it("sends signed-out visitors to sign-in from team settings", () => {
    const { allowed, response } = invokeRequireAdmin({ url: "/teams/team-1/settings" });

    expect(allowed).toBe(false);
    expect(response.writeHead).toHaveBeenCalledWith(302, {
      Location: "/auth/login?url=%2Fteams%2Fteam-1%2Fsettings",
    });
  });

  it("sends signed-out visitors to sign-in from the teams chooser", () => {
    const { allowed, response } = invokeRequireAdmin({ url: "/teams" });

    expect(allowed).toBe(false);
    expect(response.writeHead).toHaveBeenCalledWith(302, {
      Location: "/auth/login?url=%2Fteams",
    });
  });

  it("allows admins and keeps non-browser API failures as 401", () => {
    const admin = invokeRequireAdmin({ authenticated: true, admin: true });
    expect(admin.allowed).toBe(true);
    expect(admin.response.writeHead).not.toHaveBeenCalled();

    const api = invokeRequireAdmin({ method: "POST", url: "/api/v1/workflows" });
    expect(api.allowed).toBe(false);
    expect(api.response.writeHead).toHaveBeenCalledWith(401, { "Content-Type": "application/json; charset=utf-8" });
  });
});

describe("OIDC callback and browser error pages", () => {
  function response() {
    return { writeHead: vi.fn().mockReturnThis(), end: vi.fn() };
  }

  it("shows a friendly error without exposing provider exceptions when callback exchange fails", async () => {
    const sendHtmlError = vi.fn();
    const server = {
      oidc: { enabled: true, completeLogin: vi.fn().mockRejectedValue(new Error("private provider detail")) },
      oidcRedirectUri: vi.fn(() => "https://flow.test/auth/callback"),
      sendHtmlError,
    };

    await (WebhookServer.prototype as any).handleOidcCallback.call(
      server,
      { headers: { host: "flow.test" } },
      response(),
      new URL("https://flow.test/auth/callback?code=code&state=state"),
    );

    expect(sendHtmlError).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ status: 502, title: "Couldn't complete sign-in" }),
    );
    expect(JSON.stringify(sendHtmlError.mock.calls)).not.toContain("private provider detail");
  });

  it("renders a helpful 400 page for malformed callback requests", async () => {
    const sendHtmlError = vi.fn();
    const server = { oidc: { enabled: true }, sendHtmlError };

    await (WebhookServer.prototype as any).handleOidcCallback.call(
      server,
      {},
      response(),
      new URL("https://flow.test/auth/callback?code=only-code"),
    );

    expect(sendHtmlError).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ status: 400, title: "Sign-in link is incomplete" }),
    );
  });

  it("uses the branded 404 for browser navigation and JSON for API-like requests", async () => {
    const sendHtmlError = vi.fn();
    const server = { sendHtmlError };
    const browserResponse = response();
    await (WebhookServer.prototype as any).handleRequest.call(
      server,
      { url: "/missing-page", method: "GET", headers: { host: "flow.test", accept: "text/html" } },
      browserResponse,
    );
    expect(sendHtmlError).toHaveBeenCalledWith(
      browserResponse,
      expect.objectContaining({ status: 404, title: "We couldn't find that page" }),
      false,
    );

    const apiResponse = response();
    await (WebhookServer.prototype as any).handleRequest.call(
      server,
      { url: "/missing-endpoint", method: "GET", headers: { host: "flow.test", accept: "application/json" } },
      apiResponse,
    );
    expect(apiResponse.writeHead).toHaveBeenCalledWith(404, { "Content-Type": "application/json; charset=utf-8" });
    expect(apiResponse.end).toHaveBeenCalledWith(JSON.stringify({ error: "Endpoint not found" }));
  });
});

describe("OIDC session status endpoint", () => {
  it("returns 401 with an unauthenticated session state when no runner session exists", () => {
    const res = { writeHead: vi.fn().mockReturnThis(), end: vi.fn() };
    const server = { oidc: { userFromCookie: () => undefined, roleFromCookie: () => undefined, enabled: true } };

    (WebhookServer.prototype as any).handleOidcSession.call(server, { headers: {} }, res);

    expect(res.writeHead).toHaveBeenCalledWith(401, {
      "Cache-Control": "no-store",
      "Content-Type": "application/json; charset=utf-8",
    });
    expect(res.end).toHaveBeenCalledWith(
      JSON.stringify({ configured: true, authenticated: false, error: "Authentication required" }),
    );
  });

  it("returns the authenticated user and role when the runner session is valid", () => {
    const res = { writeHead: vi.fn().mockReturnThis(), end: vi.fn() };
    const user = { id: "user-1", name: "Runner", role: "user" };
    const server = {
      oidc: {
        userFromCookie: () => user,
        roleFromCookie: () => "admin",
        enabled: true,
        providerUrl: "https://auth.test",
      },
    };

    (WebhookServer.prototype as any).handleOidcSession.call(
      server,
      { headers: { cookie: "runner_oidc_session=x" } },
      res,
    );

    expect(res.writeHead).toHaveBeenCalledWith(200, {
      "Cache-Control": "no-store",
      "Content-Type": "application/json; charset=utf-8",
    });
    expect(res.end).toHaveBeenCalledWith(
      JSON.stringify({
        configured: true,
        authenticated: true,
        user: { ...user, role: "admin" },
        providerUrl: "https://auth.test",
      }),
    );
  });
});

describe("job status endpoint", () => {
  const response = () => ({
    writeHead: vi.fn().mockReturnThis(),
    end: vi.fn(),
  });
  const attachHandlers = (server: any) => {
    server.matchesToken = (req, token, allowBasic) =>
      (WebhookServer.prototype as any).matchesToken.call(server, req, token, allowBasic);
    server.isWorker = (req) => (WebhookServer.prototype as any).isWorker.call(server, req);
    server.oidcBearer = (req) => (WebhookServer.prototype as any).oidcBearer.call(server, req);
    server.requireAuthenticatedUser = (req, res) =>
      (WebhookServer.prototype as any).requireAuthenticatedUser.call(server, req, res);
    server.requireAuthenticatedApiRequest = (req, res) =>
      (WebhookServer.prototype as any).requireAuthenticatedApiRequest.call(server, req, res);
    server.userForRequest = (req) => (WebhookServer.prototype as any).userForRequest.call(server, req);
    server.requireTeam = (req, res) => (WebhookServer.prototype as any).requireTeam.call(server, req, res);
    server.isWorker = () => false;
    server.handleJobStatus = (req, jobId, res) =>
      (WebhookServer.prototype as any).handleJobStatus.call(server, req, jobId, res);
  };

  it("returns only the requested status fields", async () => {
    const server: any = {
      oidc: { userFromCookie: vi.fn(() => ({ id: "user-1" })) },
      apiKeys: { scopesForToken: vi.fn(async () => null) },
      teams: { isMember: vi.fn(async (teamId: string) => teamId === "team-a") },
      queue: {
        getJobForTeam: vi.fn(async () => ({
          id: 42,
          status: "running",
          created_at: "2026-10-10 12:00:00",
          updated_at: "2026-10-10 12:03:00",
          report: "must not be returned",
        })),
      },
    };
    attachHandlers(server);
    const res = response();

    await (WebhookServer.prototype as any).handleRequest.call(
      server,
      { method: "GET", url: "/api/v1/jobs/42/status", headers: { host: "flow.test", "x-team-id": "team-a" } },
      res,
    );

    expect(server.queue.getJobForTeam).toHaveBeenCalledWith("team-a", "42");
    expect(res.writeHead).toHaveBeenCalledWith(200, {
      "Cache-Control": "no-store",
      "Content-Type": "application/json; charset=utf-8",
    });
    expect(res.end).toHaveBeenCalledWith(
      JSON.stringify({
        id: 42,
        status: "running",
        createdAt: "2026-10-10 12:00:00",
        lastUpdated: "2026-10-10 12:03:00",
      }),
    );
  });

  it("returns 404 when the job does not exist", async () => {
    const server: any = {
      oidc: { userFromCookie: vi.fn(() => ({ id: "user-1" })) },
      apiKeys: { scopesForToken: vi.fn(async () => null) },
      teams: { isMember: vi.fn(async () => true) },
      queue: { getJobForTeam: vi.fn(async () => null) },
    };
    attachHandlers(server);
    const res = response();

    await (WebhookServer.prototype as any).handleRequest.call(
      server,
      { method: "GET", url: "/api/v1/jobs/42/status", headers: { host: "flow.test", "x-team-id": "team-a" } },
      res,
    );

    expect(res.writeHead).toHaveBeenCalledWith(404, { "Content-Type": "application/json; charset=utf-8" });
    expect(res.end).toHaveBeenCalledWith(JSON.stringify({ error: "Job not found" }));
  });

  it("accepts any active OIDC bearer token for basic status metadata", async () => {
    const server: any = {
      oidc: {
        userFromCookie: vi.fn(() => undefined),
        scopesForToken: vi.fn(async () => []),
        userFromAccessToken: vi.fn(async () => ({ id: "user-1" })),
      },
      apiKeys: { scopesForToken: vi.fn(async () => null) },
      teams: { isMember: vi.fn(async () => true) },
      queue: { getJobForTeam: vi.fn(async () => null) },
    };
    attachHandlers(server);
    const res = response();
    const req = {
      method: "GET",
      url: "/api/v1/jobs/42/status",
      headers: { host: "flow.test", authorization: "Bearer valid-oidc-token", "x-team-id": "team-a" },
    };

    await (WebhookServer.prototype as any).handleRequest.call(server, req, res);

    expect(server.oidc.scopesForToken).toHaveBeenCalledWith("valid-oidc-token");
    expect(res.writeHead).toHaveBeenCalledWith(404, { "Content-Type": "application/json; charset=utf-8" });
  });

  it("rejects requests without a session or valid bearer token", async () => {
    const server: any = {
      oidc: {
        userFromCookie: vi.fn(() => undefined),
        scopesForToken: vi.fn(async () => null),
      },
      apiKeys: { scopesForToken: vi.fn(async () => null) },
      queue: { getJobForTeam: vi.fn() },
    };
    attachHandlers(server);
    const res = response();
    const req = { method: "GET", url: "/api/v1/jobs/42/status", headers: { host: "flow.test" } };

    await (WebhookServer.prototype as any).handleRequest.call(server, req, res);

    expect(res.writeHead).toHaveBeenCalledWith(401, { "Content-Type": "application/json; charset=utf-8" });
    expect(res.end).toHaveBeenCalledWith(JSON.stringify({ error: "Authentication required" }));
    expect(server.queue.getJobForTeam).not.toHaveBeenCalled();
  });

  it("requires authentication before listing jobs", async () => {
    const server: any = {
      oidc: {
        userFromCookie: vi.fn(() => undefined),
        scopesForToken: vi.fn(async () => null),
      },
      apiKeys: { scopesForToken: vi.fn(async () => null) },
      renderDashboardJobs: vi.fn(),
    };
    attachHandlers(server);
    const res = response();

    await (WebhookServer.prototype as any).handleRequest.call(
      server,
      { method: "GET", url: "/api/v1/jobs", headers: { host: "flow.test" } },
      res,
    );

    expect(server.renderDashboardJobs).not.toHaveBeenCalled();
    expect(res.writeHead).toHaveBeenCalledWith(401, { "Content-Type": "application/json; charset=utf-8" });
  });

  it.each([
    ["OpenAPI discovery", "GET", "/api/v1"],
    ["versioned OpenAPI discovery", "GET", "/api/v1/v1"],
    ["run view", "GET", "/api/v1/runs/42"],
    ["job wait", "GET", "/api/v1/jobs/42/wait?timeout=0"],
    ["event stream", "GET", "/api/v1/events"],
    ["push public key", "GET", "/api/v1/push/public-key"],
    ["push subscribe", "POST", "/api/v1/push/subscriptions"],
    ["push unsubscribe", "DELETE", "/api/v1/push/subscriptions"],
  ])("requires authentication for %s", async (_label, method, url) => {
    const server: any = {
      oidc: {
        userFromCookie: vi.fn(() => undefined),
        scopesForToken: vi.fn(async () => null),
      },
      apiKeys: { scopesForToken: vi.fn(async () => null) },
    };
    attachHandlers(server);
    const res = response();

    await (WebhookServer.prototype as any).handleRequest.call(
      server,
      { method, url, headers: { host: "flow.test" } },
      res,
    );

    expect(res.writeHead).toHaveBeenCalledWith(401, { "Content-Type": "application/json; charset=utf-8" });
  });

  it("accepts the worker credential for the event stream", async () => {
    const subscribe = vi.fn();
    const server: any = {
      workerToken: "worker-secret",
      events: { subscribe },
      oidc: { userFromCookie: vi.fn(() => undefined) },
      apiKeys: { scopesForToken: vi.fn(async () => null) },
    };
    attachHandlers(server);
    server.isWorker = (req) => (WebhookServer.prototype as any).isWorker.call(server, req);

    await (WebhookServer.prototype as any).handleRequest.call(
      server,
      {
        method: "GET",
        url: "/api/v1/events",
        headers: { host: "flow.test", authorization: "Bearer worker-secret" },
      },
      response(),
    );

    expect(subscribe).toHaveBeenCalledOnce();
  });

  it("requires a browser session to load a run page", async () => {
    const server: any = {
      oidc: { enabled: true, userFromCookie: vi.fn(() => undefined) },
      renderRunDetails: vi.fn(),
    };
    attachHandlers(server);
    const res = response();

    await (WebhookServer.prototype as any).handleRequest.call(
      server,
      { method: "GET", url: "/ui/runs/42", headers: { host: "flow.test" } },
      res,
    );

    expect(server.renderRunDetails).not.toHaveBeenCalled();
    expect(res.writeHead).toHaveBeenCalledWith(302, { Location: "/auth/login?url=%2Fui%2Fruns%2F42" });
  });
});

function invokeRequireAuthenticatedUser(authenticated = false) {
  const response: TestResponse = {
    writeHead: vi.fn().mockReturnThis(),
    end: vi.fn(),
  };
  const server = {
    oidc: { userFromCookie: () => (authenticated ? { id: "user-1", role: "user" } : undefined) },
  };
  const request = { headers: { cookie: authenticated ? "runner_oidc_session=session" : undefined } };
  const allowed = (WebhookServer.prototype as any).requireAuthenticatedUser.call(server, request, response);
  return { allowed, request, response };
}

describe("workflow and secret settings authentication", () => {
  it("allows any signed-in OIDC user without an admin role", () => {
    const { allowed, response } = invokeRequireAuthenticatedUser(true);

    expect(allowed).toBe(true);
    expect(response.writeHead).not.toHaveBeenCalled();
  });

  it("rejects API access without an OIDC session", () => {
    const { allowed, response } = invokeRequireAuthenticatedUser();

    expect(allowed).toBe(false);
    expect(response.writeHead).toHaveBeenCalledWith(401, { "Content-Type": "application/json; charset=utf-8" });
    expect(response.end).toHaveBeenCalledWith(JSON.stringify({ error: "Authentication required" }));
  });

  it("loads workflows with a user session without requiring token scopes", async () => {
    const response: TestResponse = {
      writeHead: vi.fn().mockReturnThis(),
      end: vi.fn(),
    };
    const request = { headers: { cookie: "runner_oidc_session=session" } };
    const workflows = [{ id: "deploy-app", name: "Deploy app" }];
    const server = {
      requireTeam: vi.fn(async () => "team-a"),
      workflowsLoaded: Promise.resolve(),
      workflows: { listForTeam: vi.fn(async () => workflows) },
    };

    await (WebhookServer.prototype as any).handleWorkflowList.call(server, request, response);

    expect(server.requireTeam).toHaveBeenCalledWith(request, response);
    expect(server.workflows.listForTeam).toHaveBeenCalledWith("team-a");
    expect(response.writeHead).toHaveBeenCalledWith(200, { "Content-Type": "application/json; charset=utf-8" });
    expect(response.end).toHaveBeenCalledWith(JSON.stringify({ workflows }));
  });

  it("saves a workflow draft with a user session without requiring token scopes", async () => {
    const response: TestResponse = {
      writeHead: vi.fn().mockReturnThis(),
      end: vi.fn(),
    };
    const request = { headers: { cookie: "runner_oidc_session=session" } };
    const draft = { id: "deploy-app", revision: 2 };
    const server = {
      requireTeam: vi.fn(async () => "team-a"),
      readJson: vi.fn(async () => ({ sourceYaml: "name: Deploy app" })),
      workflows: { saveDraftForTeam: vi.fn(async () => draft) },
    };

    await (WebhookServer.prototype as any).handleWorkflowSave.call(server, request, response, "deploy-app");

    expect(server.requireTeam).toHaveBeenCalledWith(request, response);
    expect(server.workflows.saveDraftForTeam).toHaveBeenCalledWith("team-a", "deploy-app", "name: Deploy app", true);
    expect(response.writeHead).toHaveBeenCalledWith(200, { "Content-Type": "application/json; charset=utf-8" });
    expect(response.end).toHaveBeenCalledWith(JSON.stringify(draft));
  });

  it("saves a secret with a user session without requiring token scopes", async () => {
    const response: TestResponse = {
      writeHead: vi.fn().mockReturnThis(),
      end: vi.fn(),
    };
    const request = { headers: { cookie: "runner_oidc_session=session" } };
    const server = {
      requireTeam: vi.fn(async () => "team-a"),
      oidc: { userFromCookie: vi.fn(() => ({ id: "user-1" })) },
      teams: { isAdmin: vi.fn(async () => true) },
      requireSecretPermission: (req, res, teamId, scope, mutation) =>
        (WebhookServer.prototype as any).requireSecretPermission.call(server, req, res, teamId, scope, mutation),
      readJson: vi.fn(async () => ({ value: "test-secret" })),
      secretRepository: { setForTeam: vi.fn(async () => undefined) },
    };

    await (WebhookServer.prototype as any).handleSecretSave.call(server, request, response, "DEPLOY_KEY");

    expect(server.requireTeam).toHaveBeenCalledWith(request, response);
    expect(server.secretRepository.setForTeam).toHaveBeenCalledWith("team-a", "DEPLOY_KEY", "test-secret", "utf8");
    expect(response.writeHead).toHaveBeenCalledWith(204);
  });

  it.each(["/ui/settings/workflows", "/ui/settings/workflows/new"])("serves %s to any signed-in user", async (path) => {
    const server = {
      oidc: { enabled: true, userFromCookie: () => ({ id: "user-1", role: "user" }) },
      requireAuthenticatedUser: vi.fn(() => true),
      renderAppShell: vi.fn(),
    };
    const request = {
      url: path,
      method: "GET",
      headers: { host: "flow.test", cookie: "runner_oidc_session=session" },
    };
    const response = { writeHead: vi.fn(), end: vi.fn() };

    await (WebhookServer.prototype as any).handleRequest.call(server, request, response);

    expect(server.requireAuthenticatedUser).toHaveBeenCalled();
    expect(response.writeHead).toHaveBeenCalledWith(302, {
      Location: path.replace("/ui/settings/workflows", "/ui/workflows"),
    });
    expect(response.end).toHaveBeenCalledOnce();
    expect(server.renderAppShell).not.toHaveBeenCalled();
  });

  it("serves the legacy workflow/secrets component to a signed-in user", async () => {
    const server = {
      oidc: { enabled: true, userFromCookie: () => ({ id: "user-1", role: "user" }) },
      requireAuthenticatedUser: vi.fn(() => true),
      renderPageComponent: vi.fn(),
    };
    const request = {
      url: "/assets/pages/workflows.html?page=secrets",
      method: "GET",
      headers: { host: "flow.test", cookie: "runner_oidc_session=session" },
    };

    await (WebhookServer.prototype as any).handleRequest.call(server, request, {});

    expect(server.requireAuthenticatedUser).toHaveBeenCalled();
    expect(server.renderPageComponent).toHaveBeenCalledOnce();
  });

  it("does not serve removed legacy settings URLs", async () => {
    const server = {
      oidc: { enabled: true, userFromCookie: () => ({ id: "admin", role: "admin" }) },
      requireAdmin: vi.fn(() => true),
      renderAppShell: vi.fn(),
    };
    const request = {
      url: "/ui/settings/timezone",
      method: "GET",
      headers: { host: "flow.test", cookie: "runner_oidc_session=session" },
    };
    const response = { writeHead: vi.fn(), end: vi.fn() };

    await (WebhookServer.prototype as any).handleRequest.call(server, request, response);

    expect(server.requireAdmin).not.toHaveBeenCalled();
    expect(server.renderAppShell).not.toHaveBeenCalled();
    expect(response.writeHead).toHaveBeenCalledWith(404, { "Content-Type": "application/json; charset=utf-8" });
  });
});

describe("canonical route boundaries", () => {
  it.each(["/api/jobs", "/webhooks/github", "/runs", "/workflows", "/on.css", "/assets/"])(
    "rejects legacy public URL %s",
    async (url) => {
      const response = { writeHead: vi.fn(), end: vi.fn() };
      await (WebhookServer.prototype as any).handleRequest.call(
        {},
        { method: "GET", url, headers: { host: "flow.test" } },
        response,
      );
      expect(response.writeHead).toHaveBeenCalledWith(404, expect.any(Object));
      expect(response.end).toHaveBeenCalledOnce();
    },
  );

  it("serves canonical UI paths through the existing authenticated page handlers", async () => {
    const response = { writeHead: vi.fn(), end: vi.fn() };
    const server = {
      oidc: { enabled: true, userFromCookie: vi.fn(() => ({ id: "user-1" })) },
      requireAuthenticatedUser: vi.fn(() => true),
      renderAppShell: vi.fn(),
    };
    await (WebhookServer.prototype as any).handleRequest.call(
      server,
      { method: "GET", url: "/ui/workflows", headers: { host: "flow.test", cookie: "session" } },
      response,
    );
    expect(server.requireAuthenticatedUser).toHaveBeenCalledOnce();
    expect(server.renderAppShell).toHaveBeenCalledWith(response);
    expect(response.writeHead).not.toHaveBeenCalledWith(404, expect.anything());
  });

  it("uses registered friendly names in worker presence responses", async () => {
    const response = { writeHead: vi.fn().mockReturnThis(), end: vi.fn() };
    const server = {
      workflowsLoaded: Promise.resolve(),
      hasScope: vi.fn(async () => true),
      queue: { listWorkerPresence: vi.fn(async () => [{ workerId: "runner-1", online: true }]) },
      runners: { list: vi.fn(async () => [{ id: "runner-1", name: "build-west" }]) },
    };
    await (WebhookServer.prototype as any).handleRequest.call(
      server,
      { method: "GET", url: "/api/v1/workers", headers: { host: "flow.test" } },
      response,
    );
    expect(JSON.parse(response.end.mock.calls[0][0])).toEqual({
      workers: [{ workerId: "runner-1", online: true, name: "build-west" }],
    });
  });

  it("allows only server administrators to rename a runner over the v1 API", async () => {
    const response = { writeHead: vi.fn().mockReturnThis(), end: vi.fn() };
    const server = {
      workflowsLoaded: Promise.resolve(),
      requireSameOrigin: vi.fn(() => true),
      requireAuthenticatedUser: vi.fn(() => true),
      oidc: { userFromCookie: vi.fn(() => ({ id: "admin-user" })) },
      oidcUsers: { role: vi.fn(async () => "admin") },
      readJson: vi.fn(async () => ({ name: "build-west" })),
      runners: {
        rename: vi.fn(async () => true),
        list: vi.fn(async () => [{ id: "runner-1", name: "build-west" }]),
      },
    };
    await (WebhookServer.prototype as any).handleRequest.call(
      server,
      {
        method: "PUT",
        url: "/api/v1/runners/runner-1",
        headers: { host: "flow.test", origin: "https://flow.test", cookie: "session" },
      },
      response,
    );
    expect(server.runners.rename).toHaveBeenCalledWith("runner-1", "build-west");
    expect(response.writeHead).toHaveBeenCalledWith(200, expect.objectContaining({ "Cache-Control": "no-store" }));
  });

  it("does not rename runners for a non-admin OIDC user", async () => {
    const response = { writeHead: vi.fn().mockReturnThis(), end: vi.fn() };
    const server = {
      workflowsLoaded: Promise.resolve(),
      requireSameOrigin: vi.fn(() => true),
      requireAuthenticatedUser: vi.fn(() => true),
      oidc: { userFromCookie: vi.fn(() => ({ id: "user-1" })) },
      oidcUsers: { role: vi.fn(async () => "user") },
      runners: { rename: vi.fn() },
    };
    await (WebhookServer.prototype as any).handleRequest.call(
      server,
      {
        method: "PUT",
        url: "/api/v1/runners/runner-1",
        headers: { host: "flow.test", origin: "https://flow.test", cookie: "session" },
      },
      response,
    );
    expect(server.runners.rename).not.toHaveBeenCalled();
    expect(response.writeHead).toHaveBeenCalledWith(403, expect.objectContaining({ "Cache-Control": "no-store" }));
  });
});

describe("team authorization", () => {
  it("does not let arbitrary workspace API keys manage legacy global API keys", async () => {
    const server = {
      isAdmin: vi.fn(() => false),
      oidc: { userFromCookie: vi.fn(() => undefined), scopesForToken: vi.fn(async () => null) },
      oidcBearer: (req: any) => req.headers.authorization?.slice(7),
    };

    await expect(
      (WebhookServer.prototype as any).canManageLegacyApiKeys.call(server, {
        headers: { authorization: "Bearer workspace-api-key" },
      }),
    ).resolves.toBe(false);
    expect(server.oidc.scopesForToken).toHaveBeenCalledWith("workspace-api-key");
  });

  it("preserves legacy API-key management for valid OIDC bearer tokens", async () => {
    const server = {
      isAdmin: vi.fn(() => false),
      oidc: { userFromCookie: vi.fn(() => undefined), scopesForToken: vi.fn(async () => ["api-tokens:manage"]) },
      oidcBearer: (req: any) => req.headers.authorization?.slice(7),
    };

    await expect(
      (WebhookServer.prototype as any).canManageLegacyApiKeys.call(server, {
        headers: { authorization: "Bearer oidc-access-token" },
      }),
    ).resolves.toBe(true);
  });

  it("binds API-key requests to the workspace stored on the key, not the caller header", async () => {
    const response = { writeHead: vi.fn().mockReturnThis(), end: vi.fn() };
    const server = {
      userForRequest: vi.fn(async () => undefined),
      oidcBearer: (req: any) => req.headers.authorization?.slice(7),
      apiKeys: { tokenDetails: vi.fn(async () => ({ scopes: ["workflows:read"], teamId: "workspace-a" })) },
      teams: { isMember: vi.fn() },
    };

    await expect(
      (WebhookServer.prototype as any).requireTeam.call(
        server,
        {
          method: "GET",
          url: "/api/v1/workflows",
          headers: { authorization: "Bearer key", "x-team-id": "workspace-b" },
        },
        response,
      ),
    ).resolves.toBeNull();
    expect(response.writeHead).toHaveBeenCalledWith(404, { "Content-Type": "application/json" });
    expect(server.teams.isMember).not.toHaveBeenCalled();
  });

  it("allows workspace API keys to use only their stored workspace and granted scope", async () => {
    const server = {
      isAdmin: vi.fn(() => false),
      oidc: undefined,
      apiKeys: { tokenDetails: vi.fn(async () => ({ scopes: ["workflows:read"], teamId: "workspace-a" })) },
    };
    const request = { headers: { authorization: "Bearer key" } };

    await expect((WebhookServer.prototype as any).hasScope.call(server, request, "workflows:read")).resolves.toBe(true);
    await expect((WebhookServer.prototype as any).hasScope.call(server, request, "runs:control")).resolves.toBe(false);
  });

  it("requires mapped API-key scopes while preserving documented scope-free job status", async () => {
    const server = {
      userForRequest: vi.fn(async () => undefined),
      oidcBearer: () => "key",
      apiKeys: { tokenDetails: vi.fn(async () => ({ scopes: ["workflows:read"], teamId: "workspace-a" })) },
      teams: { isMember: vi.fn() },
      apiKeyScopeForRequest: (req: any) => (WebhookServer.prototype as any).apiKeyScopeForRequest.call(server, req),
    };
    const response = { writeHead: vi.fn().mockReturnThis(), end: vi.fn() };

    await expect(
      (WebhookServer.prototype as any).requireTeam.call(
        server,
        { method: "GET", url: "/api/v1/workflows", headers: { "x-team-id": "workspace-a" } },
        response,
      ),
    ).resolves.toBe("workspace-a");
    await expect(
      (WebhookServer.prototype as any).requireTeam.call(
        server,
        { method: "POST", url: "/api/v1/workflows", headers: { "x-team-id": "workspace-a" } },
        response,
      ),
    ).resolves.toBeNull();
    await expect(
      (WebhookServer.prototype as any).requireTeam.call(
        server,
        { method: "GET", url: "/api/v1/jobs/42/status", headers: { "x-team-id": "workspace-a" } },
        response,
      ),
    ).resolves.toBe("workspace-a");
    await expect(
      (WebhookServer.prototype as any).requireTeam.call(
        server,
        { method: "GET", url: "/api/v1/jobs?limit=10", headers: { "x-team-id": "workspace-a" } },
        response,
      ),
    ).resolves.toBeNull();
    expect(response.writeHead).toHaveBeenLastCalledWith(403, { "Content-Type": "application/json" });
  });

  it("maps versioned API aliases to the same API-key scopes as canonical routes", () => {
    const server = {};
    const scopeFor = (url: string, method: string) =>
      (WebhookServer.prototype as any).apiKeyScopeForRequest.call(server, { url, method });

    expect(scopeFor("/api/v1/jobs?limit=10", "GET")).toBe("logs:read");
    expect(scopeFor("/api/v1/jobs?limit=10", "GET")).toBe("logs:read");
    expect(scopeFor("/api/v1/jobs/42/status", "GET")).toBe("none");
    expect(scopeFor("/api/v1/workflows", "GET")).toBe("workflows:read");
    expect(scopeFor("/api/v1/workflows/build", "PUT")).toBe("workflows:write");
    expect(scopeFor("/api/v1/workflows/build/run", "POST")).toBe("runs:dispatch");
    expect(scopeFor("/api/v1/runner/leases", "POST")).toBeNull();
  });

  it("allows an all-scopes workspace API key to list jobs through the versioned route", async () => {
    const scopes = [
      "workflows:read",
      "workflows:write",
      "logs:read",
      "artifacts:read",
      "runs:control",
      "runs:dispatch",
      "workers:read",
      "secrets:read",
      "secrets:write",
    ];
    const server = {
      userForRequest: vi.fn(async () => undefined),
      oidcBearer: (req: any) => req.headers.authorization?.slice(7),
      apiKeys: { tokenDetails: vi.fn(async () => ({ scopes, teamId: "workspace-a" })) },
      teams: { isMember: vi.fn() },
      apiKeyScopeForRequest: (req: any) => (WebhookServer.prototype as any).apiKeyScopeForRequest.call(server, req),
    };

    await expect(
      (WebhookServer.prototype as any).requireTeam.call(
        server,
        { method: "GET", url: "/api/v1/jobs?limit=10", headers: { authorization: "Bearer key" } },
        { writeHead: vi.fn().mockReturnThis(), end: vi.fn() },
      ),
    ).resolves.toBe("workspace-a");
  });

  it("does not let a browser session broaden a workspace API key's team or scopes", async () => {
    const response = { writeHead: vi.fn().mockReturnThis(), end: vi.fn() };
    const server = {
      oidc: { userFromCookie: vi.fn(() => ({ id: "member-a" })) },
      userForRequest: vi.fn(async () => ({ id: "member-a" })),
      oidcBearer: (req: any) => (req.headers.authorization || "").replace(/^Bearer /, "") || undefined,
      apiKeys: { tokenDetails: vi.fn(async () => ({ scopes: ["workflows:read"], teamId: "workspace-a" })) },
      teams: { isMember: vi.fn(async () => true) },
      apiKeyScopeForRequest: (req: any) => (WebhookServer.prototype as any).apiKeyScopeForRequest.call(server, req),
    };

    await expect(
      (WebhookServer.prototype as any).requireTeam.call(
        server,
        {
          method: "GET",
          url: "/api/v1/secrets",
          headers: { authorization: "Bearer workspace-key", cookie: "session", "x-team-id": "workspace-a" },
        },
        response,
      ),
    ).resolves.toBeNull();
    expect(response.writeHead).toHaveBeenCalledWith(403, { "Content-Type": "application/json" });
  });

  it("allows only workspace admins to create workspace API keys", async () => {
    const res = { writeHead: vi.fn().mockReturnThis(), end: vi.fn() };
    const server = {
      oidc: { userFromCookie: vi.fn(() => ({ id: "admin-user" })) },
      userForRequest: vi.fn(async () => ({ id: "admin-user" })),
      requireSameOrigin: vi.fn(() => true),
      workflowsLoaded: Promise.resolve(),
      teams: { isAdmin: vi.fn(async () => true) },
      apiKeys: { issue: vi.fn(async () => ({ id: "key-id", token: "one-time-token" })) },
      readJson: vi.fn(async () => ({ name: "deploy", scopes: ["runs:dispatch"] })),
    };

    await (WebhookServer.prototype as any).handleTeams.call(
      server,
      {
        method: "POST",
        url: "/api/workspaces/workspace-a/api-keys",
        headers: { cookie: "session", origin: "https://flow.test" },
      },
      res,
      new URL("http://flow.test/api/workspaces/workspace-a/api-keys"),
    );

    expect(server.teams.isAdmin).toHaveBeenCalledWith("workspace-a", "admin-user");
    expect(server.apiKeys.issue).toHaveBeenCalledWith("workspace-a", "deploy", ["runs:dispatch"]);
    expect(res.writeHead).toHaveBeenCalledWith(201, expect.objectContaining({ "Cache-Control": "no-store" }));
  });

  it("does not use an unscoped environment secret for webhook preprocessing", async () => {
    const previousSecret = process.env.GITHUB_WEBHOOK_SECRET;
    process.env.GITHUB_WEBHOOK_SECRET = "legacy-github-secret";
    const parse = vi.fn(() => ({ isValid: true, inputs: {} }));
    const server = {
      secretRepository: { getAllForTeam: vi.fn(async () => ({})) },
      secrets: { get: vi.fn() },
      preprocessors: { get: vi.fn(() => ({ parse })) },
    };

    try {
      await (WebhookServer.prototype as any).preprocess.call(server, "github", {}, Buffer.from("{}"), "default");
      expect(parse).toHaveBeenCalledWith({}, Buffer.from("{}"), undefined);
    } finally {
      if (previousSecret === undefined) {
        delete process.env.GITHUB_WEBHOOK_SECRET;
      } else {
        process.env.GITHUB_WEBHOOK_SECRET = previousSecret;
      }
    }
  });

  it("routes the legacy provider webhook to the adopted workspace while the migration marker exists", async () => {
    const get = vi.spyOn(db, "get");
    get
      .mockResolvedValueOnce({ 1: 1 } as never)
      .mockResolvedValueOnce({ target_workspace_id: "workspace-new" } as never);
    try {
      await expect((WebhookServer.prototype as any).legacyWebhookWorkspace.call({})).resolves.toBe("workspace-new");
      expect(get).toHaveBeenNthCalledWith(
        1,
        "SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'workspace_adoptions'",
      );
      expect(get).toHaveBeenNthCalledWith(
        2,
        "SELECT target_workspace_id FROM workspace_adoptions WHERE version = ? AND source_workspace_id = 'default'",
        ["default-to-workspace-v1"],
      );
    } finally {
      get.mockRestore();
    }
  });

  it("requires an authenticated team member and hides teams the caller cannot access", async () => {
    const response = { writeHead: vi.fn().mockReturnThis(), end: vi.fn() };
    const server = {
      oidc: { userFromCookie: () => ({ id: "member-1" }) },
      oidcBearer: (req: any) => (req.headers.authorization || "").replace(/^Bearer /, "") || undefined,
      teams: { isMember: vi.fn(async (teamId: string) => teamId === "team-a") },
    };
    const request = { url: "/api/v1/workflows", headers: { cookie: "session", "x-team-id": "team-b" } };

    await expect((WebhookServer.prototype as any).requireTeam.call(server, request, response)).resolves.toBeNull();
    expect(response.writeHead).toHaveBeenCalledWith(404, { "Content-Type": "application/json" });
    expect(server.teams.isMember).toHaveBeenCalledWith("team-b", "member-1");
  });

  it("scopes webhook matching to the team selected by its unique URL token", async () => {
    const response = { writeHead: vi.fn().mockReturnThis(), end: vi.fn() };
    const workflows = [{ workflowId: "team-a-flow", revision: 1 }];
    const server = {
      readRequest: vi.fn(async () => ({ rawBuffer: Buffer.from("{}"), headers: {} })),
      preprocess: vi.fn(async (_provider: string, _headers: unknown, _raw: Buffer, teamId: string) => ({
        isValid: true,
        inputs: {},
        secretValues: { TEAM: teamId },
      })),
      workflowsLoaded: Promise.resolve(),
      workflows: { publishedForTeam: vi.fn(async (teamId: string) => (teamId === "team-a" ? workflows : [])) },
      matchWorkflows: vi.fn(async () => []),
    };

    await (WebhookServer.prototype as any).handleWebhook.call(server, "github", {}, response, "team-a");

    expect(server.preprocess).toHaveBeenCalledWith("github", {}, Buffer.from("{}"), "team-a", undefined);
    expect(server.workflows.publishedForTeam).toHaveBeenCalledWith("team-a");
    expect(server.matchWorkflows).toHaveBeenCalledWith("github", {}, workflows, { TEAM: "team-a" }, "team-a");
    expect(response.writeHead).toHaveBeenCalledWith(202, { "Content-Type": "application/json" });
  });
});

describe("admin user-management authorization", () => {
  const makeResponse = () => ({
    writeHead: vi.fn().mockReturnThis(),
    end: vi.fn(),
  });

  const makeServer = ({
    isAdmin = false,
    authenticated = false,
    users = [] as any[],
    roleResult = "updated" as string,
  } = {}) => {
    const server: any = {
      isAdmin: vi.fn(() => isAdmin),
      oidc: {
        userFromCookie: vi.fn(() => (authenticated ? { id: "caller-subject" } : undefined)),
        setRoleForUser: vi.fn(),
      },
      requireSameOrigin: vi.fn(() => true),
      workflowsLoaded: Promise.resolve(),
      oidcUsers: {
        list: vi.fn(async () => users),
        setRole: vi.fn(async () => roleResult),
      },
      readJson: vi.fn(async () => ({ role: "user" })),
    };
    server.requireAdminSession = (request: unknown, response: unknown) =>
      (WebhookServer.prototype as any).requireAdminSession.call(server, request, response);
    return server;
  };

  it("lists users only for an admin OIDC session (bearer tokens do not grant access)", async () => {
    const server = makeServer({ authenticated: true, isAdmin: false });
    const response = makeResponse();
    const request = {
      method: "GET",
      url: "/api/v1/users",
      headers: { host: "flow.test", cookie: "runner_oidc_session=user", authorization: "Bearer scoped-token" },
    };

    await (WebhookServer.prototype as any).handleRequest.call(server, request, response);

    expect(response.writeHead).toHaveBeenCalledWith(403, { "Content-Type": "application/json; charset=utf-8" });
    expect(server.oidcUsers.list).not.toHaveBeenCalled();
  });

  it("lists roster data for admins only", async () => {
    const users = [{ id: "user-1", name: "Example", email: "example@example.test", role: "user" }];
    const server = makeServer({ authenticated: true, isAdmin: true, users });
    const response = makeResponse();

    await (WebhookServer.prototype as any).handleRequest.call(
      server,
      {
        method: "GET",
        url: "/api/v1/users",
        headers: { host: "flow.test", origin: "https://flow.test", cookie: "runner_oidc_session=admin" },
      },
      response,
    );

    expect(response.writeHead).toHaveBeenCalledWith(200, expect.objectContaining({ "Cache-Control": "no-store" }));
    expect(response.end).toHaveBeenCalledWith(JSON.stringify({ users }));
  });

  it("rejects demotion of the last administrator and does not alter active sessions", async () => {
    const server = makeServer({ authenticated: true, isAdmin: true, roleResult: "last-admin" });
    const response = makeResponse();

    await (WebhookServer.prototype as any).handleRequest.call(
      server,
      {
        method: "PUT",
        url: "/api/v1/users/target-subject/role",
        headers: { host: "flow.test", origin: "https://flow.test", cookie: "runner_oidc_session=admin" },
      },
      response,
    );

    expect(server.oidcUsers.setRole).toHaveBeenCalledWith("target-subject", "user");
    expect(response.writeHead).toHaveBeenCalledWith(409, { "Content-Type": "application/json; charset=utf-8" });
    expect(server.oidc.setRoleForUser).not.toHaveBeenCalled();
  });

  it("propagates a successful role change to sessions for the target subject", async () => {
    const server = makeServer({ authenticated: true, isAdmin: true, roleResult: "updated" });
    const response = makeResponse();
    server.oidcUsers.list.mockResolvedValue([{ id: "target-subject", name: "Target", role: "user" }]);

    await (WebhookServer.prototype as any).handleRequest.call(
      server,
      {
        method: "PUT",
        url: "/api/v1/users/target-subject/role",
        headers: { host: "flow.test", cookie: "runner_oidc_session=admin" },
      },
      response,
    );

    expect(server.oidc.setRoleForUser).toHaveBeenCalledWith("target-subject", "user");
    expect(response.end).toHaveBeenCalledWith(
      JSON.stringify({ user: { id: "target-subject", name: "Target", role: "user" } }),
    );
  });
});

describe("per-user UI timezone preference", () => {
  const makeResponse = () => ({ writeHead: vi.fn().mockReturnThis(), end: vi.fn() });

  const makeServer = (timezone: string) => ({
    requireAuthenticatedUser: vi.fn(() => true),
    oidc: { userFromCookie: vi.fn(() => ({ id: "timezone-user" })) },
    userPreferences: {
      getTimezone: vi.fn(async () => timezone),
      setTimezone: vi.fn(async () => undefined),
    },
    readJson: vi.fn(async () => ({ timezone })),
  });

  it("returns the saved timezone for the authenticated user", async () => {
    const server = makeServer("America/Los_Angeles");
    const response = makeResponse();

    await (WebhookServer.prototype as any).handleRequest.call(
      server,
      { method: "GET", url: "/api/v1/preferences", headers: { host: "flow.test", cookie: "session" } },
      response,
    );

    expect(server.userPreferences.getTimezone).toHaveBeenCalledWith("timezone-user");
    expect(response.end).toHaveBeenCalledWith(JSON.stringify({ timezone: "America/Los_Angeles" }));
  });

  it("persists valid IANA timezones and rejects invalid ones", async () => {
    const server = makeServer("America/Los_Angeles");
    const response = makeResponse();

    await (WebhookServer.prototype as any).handleRequest.call(
      server,
      { method: "PUT", url: "/api/v1/preferences", headers: { host: "flow.test", cookie: "session" } },
      response,
    );

    expect(server.userPreferences.setTimezone).toHaveBeenCalledWith("timezone-user", "America/Los_Angeles");
    expect(response.end).toHaveBeenCalledWith(JSON.stringify({ timezone: "America/Los_Angeles" }));

    server.readJson.mockResolvedValue({ timezone: "Not/A_Real_Timezone" });
    const invalidResponse = makeResponse();
    await (WebhookServer.prototype as any).handleRequest.call(
      server,
      { method: "PUT", url: "/api/v1/preferences", headers: { host: "flow.test", cookie: "session" } },
      invalidResponse,
    );
    expect(invalidResponse.writeHead).toHaveBeenCalledWith(400, { "Content-Type": "application/json; charset=utf-8" });
  });
});

describe("authenticated profile endpoint", () => {
  it("returns only the signed-in display identity, role, and OIDC profile URL without caching", async () => {
    const response: TestResponse = { writeHead: vi.fn().mockReturnThis(), end: vi.fn() };
    const server = {
      requireAuthenticatedUser: vi.fn(() => true),
      oidc: {
        providerUrl: "https://identity.example.test/",
        userFromCookie: vi.fn(() => ({ id: "subject-1", name: "Alex Example", email: "alex@example.test" })),
      },
      oidcUsers: { role: vi.fn(async () => "admin") },
    };

    await (WebhookServer.prototype as any).handleRequest.call(
      server,
      { method: "GET", url: "/api/v1/session", headers: { host: "flow.test", cookie: "session" } },
      response,
    );

    expect(server.oidcUsers.role).toHaveBeenCalledWith("subject-1");
    expect(response.writeHead).toHaveBeenCalledWith(200, {
      "Cache-Control": "no-store",
      "Content-Type": "application/json; charset=utf-8",
    });
    expect(response.end).toHaveBeenCalledWith(
      JSON.stringify({
        user: { name: "Alex Example", email: "alex@example.test", role: "admin" },
        meUrl: "https://identity.example.test/me",
      }),
    );
  });

  it("does not expose a profile response without an OIDC user session", async () => {
    const response: TestResponse = { writeHead: vi.fn().mockReturnThis(), end: vi.fn() };
    const server = {
      requireAuthenticatedUser: vi.fn(() => true),
      oidc: { userFromCookie: vi.fn(() => undefined) },
      oidcUsers: { role: vi.fn() },
    };

    await (WebhookServer.prototype as any).handleRequest.call(
      server,
      { method: "GET", url: "/api/v1/session", headers: { host: "flow.test" } },
      response,
    );

    expect(response.writeHead).toHaveBeenCalledWith(401, {
      "Cache-Control": "no-store",
      "Content-Type": "application/json; charset=utf-8",
    });
    expect(server.oidcUsers.role).not.toHaveBeenCalled();
  });
});
