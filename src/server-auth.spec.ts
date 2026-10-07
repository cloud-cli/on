import { describe, expect, it, vi } from "vitest";
import { WebhookServer } from "./server.js";

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
    expect(response.writeHead).toHaveBeenCalledWith(302, { Location: "/settings/tokens" });
    expect(response.end).toHaveBeenCalledOnce();
  });

  it("redirects signed-out visitors to sign-in with the original route and query", () => {
    const { allowed, response } = invokeRequireAdmin({ url: "/settings/workflows/build?revision=3" });

    expect(allowed).toBe(false);
    expect(response.writeHead).toHaveBeenCalledWith(302, {
      Location: "/auth/login?url=%2Fsettings%2Fworkflows%2Fbuild%3Frevision%3D3",
    });
  });

  it("allows admins and keeps non-browser API failures as 401", () => {
    const admin = invokeRequireAdmin({ authenticated: true, admin: true });
    expect(admin.allowed).toBe(true);
    expect(admin.response.writeHead).not.toHaveBeenCalled();

    const api = invokeRequireAdmin({ method: "POST", url: "/api/workflows" });
    expect(api.allowed).toBe(false);
    expect(api.response.writeHead).toHaveBeenCalledWith(401, { "Content-Type": "application/json; charset=utf-8" });
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
      requireAuthenticatedUser: vi.fn(() => true),
      workflowsLoaded: Promise.resolve(),
      workflows: { list: vi.fn(async () => workflows) },
    };

    await (WebhookServer.prototype as any).handleWorkflowList.call(server, request, response);

    expect(server.requireAuthenticatedUser).toHaveBeenCalledWith(request, response);
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
      requireAuthenticatedUser: vi.fn(() => true),
      readJson: vi.fn(async () => ({ sourceYaml: "name: Deploy app" })),
      workflows: { saveDraft: vi.fn(async () => draft) },
    };

    await (WebhookServer.prototype as any).handleWorkflowSave.call(server, request, response, "deploy-app");

    expect(server.requireAuthenticatedUser).toHaveBeenCalledWith(request, response);
    expect(server.workflows.saveDraft).toHaveBeenCalledWith("deploy-app", "name: Deploy app", true);
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
      requireAuthenticatedUser: vi.fn(() => true),
      readJson: vi.fn(async () => ({ value: "test-secret" })),
      secretRepository: { set: vi.fn(async () => undefined) },
    };

    await (WebhookServer.prototype as any).handleSecretSave.call(server, request, response, "DEPLOY_KEY");

    expect(server.requireAuthenticatedUser).toHaveBeenCalledWith(request, response);
    expect(server.secretRepository.set).toHaveBeenCalledWith("DEPLOY_KEY", "test-secret", "utf8");
    expect(response.writeHead).toHaveBeenCalledWith(204);
  });

  it.each(["/settings/workflows", "/settings/secrets", "/settings/workflows/new"])(
    "serves %s to any signed-in user",
    async (path) => {
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
      if (path === "/settings/secrets") {
        expect(server.renderAppShell).toHaveBeenCalledOnce();
      } else {
        expect(response.writeHead).toHaveBeenCalledWith(302, {
          Location: path.replace(/^\/settings\/workflows/, "/workflows"),
        });
        expect(response.end).toHaveBeenCalledOnce();
        expect(server.renderAppShell).not.toHaveBeenCalled();
      }
    },
  );

  it("serves the legacy workflow/secrets component to a signed-in user", async () => {
    const server = {
      oidc: { enabled: true, userFromCookie: () => ({ id: "user-1", role: "user" }) },
      requireAuthenticatedUser: vi.fn(() => true),
      renderPageComponent: vi.fn(),
    };
    const request = {
      url: "/pages/workflows.html?page=secrets",
      method: "GET",
      headers: { host: "flow.test", cookie: "runner_oidc_session=session" },
    };

    await (WebhookServer.prototype as any).handleRequest.call(server, request, {});

    expect(server.requireAuthenticatedUser).toHaveBeenCalled();
    expect(server.renderPageComponent).toHaveBeenCalledOnce();
  });

  it("routes the legacy timezone URL to the app shell behind the existing admin gate", async () => {
    const server = {
      oidc: { enabled: true, userFromCookie: () => ({ id: "admin", role: "admin" }) },
      requireAdmin: vi.fn(() => true),
      renderAppShell: vi.fn(),
    };
    const request = {
      url: "/settings/timezone",
      method: "GET",
      headers: { host: "flow.test", cookie: "runner_oidc_session=session" },
    };

    await (WebhookServer.prototype as any).handleRequest.call(server, request, {});

    expect(server.requireAdmin).toHaveBeenCalledOnce();
    expect(server.renderAppShell).toHaveBeenCalledOnce();
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
      url: "/api/users",
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
        url: "/api/users",
        headers: { host: "flow.test", cookie: "runner_oidc_session=admin" },
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
        url: "/api/users/target-subject/role",
        headers: { host: "flow.test", cookie: "runner_oidc_session=admin" },
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
        url: "/api/users/target-subject/role",
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
      { method: "GET", url: "/api/preferences", headers: { host: "flow.test", cookie: "session" } },
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
      { method: "PUT", url: "/api/preferences", headers: { host: "flow.test", cookie: "session" } },
      response,
    );

    expect(server.userPreferences.setTimezone).toHaveBeenCalledWith("timezone-user", "America/Los_Angeles");
    expect(response.end).toHaveBeenCalledWith(JSON.stringify({ timezone: "America/Los_Angeles" }));

    server.readJson.mockResolvedValue({ timezone: "Not/A_Real_Timezone" });
    const invalidResponse = makeResponse();
    await (WebhookServer.prototype as any).handleRequest.call(
      server,
      { method: "PUT", url: "/api/preferences", headers: { host: "flow.test", cookie: "session" } },
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
      { method: "GET", url: "/api/session", headers: { host: "flow.test", cookie: "session" } },
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
      { method: "GET", url: "/api/session", headers: { host: "flow.test" } },
      response,
    );

    expect(response.writeHead).toHaveBeenCalledWith(401, {
      "Cache-Control": "no-store",
      "Content-Type": "application/json; charset=utf-8",
    });
    expect(server.oidcUsers.role).not.toHaveBeenCalled();
  });
});
