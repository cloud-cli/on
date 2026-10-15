import { describe, expect, it, vi } from "vitest";
import { WebhookServer } from "./server.js";

function makeResponse() {
  return { writeHead: vi.fn().mockReturnThis(), end: vi.fn() };
}

function makeServer(scopes: string[] | null = ["workflows:read", "workflows:write"], workflows = {}) {
  const server: any = {
    oidc: {
      userFromCookie: vi.fn(() => undefined),
      scopesForToken: vi.fn(async () => null),
    },
    apiKeys: {
      scopesForToken: vi.fn(async (token: string) => (token === "test-key" ? scopes : null)),
      tokenDetails: vi.fn(async (token: string) =>
        token === "test-key" && scopes ? { scopes, teamId: "workspace-a" } : null,
      ),
    },
    workflowsLoaded: Promise.resolve(),
    workflows: {
      list: vi.fn(async () => []),
      listActive: vi.fn(async () => []),
      listForTeam: vi.fn(async () => []),
      listActiveForTeam: vi.fn(async () => []),
      get: vi.fn(async () => null),
      getForTeam: vi.fn(async () => null),
      getRevisionSnapshot: vi.fn(async () => null),
      saveDraft: vi.fn(async () => ({ id: "test", sourceYaml: "name: Test" })),
      saveDraftForTeam: vi.fn(async () => ({ id: "test", sourceYaml: "name: Test" })),
      delete: vi.fn(async () => true),
      deleteForTeam: vi.fn(async () => true),
      ...workflows,
    },
    handleWorkflowPublish: vi.fn(),
    isAdmin: () => false,
  };
  server.oidcBearer = (req) => (WebhookServer.prototype as any).oidcBearer.call(server, req);
  server.hasScope = (req, scope) => (WebhookServer.prototype as any).hasScope.call(server, req, scope);
  server.requireAuthenticatedApiRequest = (req, res) =>
    (WebhookServer.prototype as any).requireAuthenticatedApiRequest.call(server, req, res);
  server.requireWorkflowApiScope = (req, res, scope) =>
    (WebhookServer.prototype as any).requireWorkflowApiScope.call(server, req, res, scope);
  server.requireTeam = vi.fn(async () => "workspace-a");
  server.readRequest = (req, res) => (WebhookServer.prototype as any).readRequest.call(server, req, res);
  server.readJson = (req, res) => (WebhookServer.prototype as any).readJson.call(server, req, res);
  return server;
}

function makeRequest(method: string, url: string, body?: unknown) {
  return {
    method,
    url,
    headers: { host: "flow.test", authorization: "Bearer test-key" },
    async *[Symbol.asyncIterator]() {
      if (body !== undefined) {
        yield Buffer.from(JSON.stringify(body));
      }
    },
  };
}

describe("scoped workflow API v1", () => {
  it("lists only active workflows when requested with a read-scoped key", async () => {
    const workflows = [{ id: "test", sourceYaml: "name: Test", status: "published", enabled: true }];
    const server = makeServer(["workflows:read"], { listActiveForTeam: vi.fn(async () => workflows) });
    const res = makeResponse();

    await (WebhookServer.prototype as any).handleRequest.call(
      server,
      makeRequest("GET", "/api/v1/workflows?activeOnly=true"),
      res,
    );

    expect(server.workflows.listActiveForTeam).toHaveBeenCalledWith("workspace-a");
    expect(server.workflows.listForTeam).not.toHaveBeenCalled();
    expect(server.workflows.listActive).not.toHaveBeenCalled();
    expect(res.writeHead).toHaveBeenCalledWith(200, {
      "Cache-Control": "no-store",
      "Content-Type": "application/json; charset=utf-8",
    });
    expect(res.end).toHaveBeenCalledWith(JSON.stringify({ workflows }));
  });

  it("reads an individual workflow only from the requested workspace", async () => {
    const workflow = { id: "test", sourceYaml: "name: Test", revision: 1, status: "draft", enabled: true };
    const server = makeServer(["workflows:read"], { getForTeam: vi.fn(async () => workflow) });
    const res = makeResponse();

    await (WebhookServer.prototype as any).handleRequest.call(
      server,
      makeRequest("GET", "/api/v1/workflows/test"),
      res,
    );

    expect(server.requireTeam).toHaveBeenCalledOnce();
    expect(server.workflows.getForTeam).toHaveBeenCalledWith("workspace-a", "test");
    expect(server.workflows.get).not.toHaveBeenCalled();
    expect(res.writeHead).toHaveBeenCalledWith(200, {
      "Cache-Control": "no-store",
      "Content-Type": "application/json; charset=utf-8",
    });
    expect(res.end).toHaveBeenCalledWith(JSON.stringify(workflow));
  });

  it("does not list workflows when workspace authorization fails", async () => {
    const server = makeServer();
    server.requireTeam.mockResolvedValue(null);
    const res = makeResponse();

    await (WebhookServer.prototype as any).handleRequest.call(server, makeRequest("GET", "/api/v1/workflows"), res);

    expect(server.workflows.listForTeam).not.toHaveBeenCalled();
  });

  it("rejects a valid API key without the required scope", async () => {
    const server = makeServer(["workflows:read"]);
    const res = makeResponse();

    await (WebhookServer.prototype as any).handleRequest.call(
      server,
      makeRequest("DELETE", "/api/v1/workflows/test"),
      res,
    );

    expect(res.writeHead).toHaveBeenCalledWith(403, { "Content-Type": "application/json; charset=utf-8" });
    expect(res.end).toHaveBeenCalledWith(JSON.stringify({ error: "Missing required scope: workflows:write" }));
    expect(server.workflows.delete).not.toHaveBeenCalled();
  });

  it("saves workflow drafts with a write-scoped key", async () => {
    const saved = { id: "test", sourceYaml: "name: Test", revision: 3, status: "draft", enabled: false };
    const server = makeServer(["workflows:write"], { saveDraftForTeam: vi.fn(async () => saved) });
    const res = makeResponse();

    await (WebhookServer.prototype as any).handleRequest.call(
      server,
      makeRequest("PUT", "/api/v1/workflows/test", { sourceYaml: "name: Test", enabled: false }),
      res,
    );

    expect(server.workflows.saveDraftForTeam).toHaveBeenCalledWith("workspace-a", "test", "name: Test", false);
    expect(server.workflows.saveDraft).not.toHaveBeenCalled();
    expect(res.writeHead).toHaveBeenCalledWith(200, {
      "Cache-Control": "no-store",
      "Content-Type": "application/json; charset=utf-8",
    });
    expect(res.end).toHaveBeenCalledWith(JSON.stringify(saved));
  });

  it("deletes workflows with a write-scoped key", async () => {
    const server = makeServer(["workflows:write"]);
    const res = makeResponse();

    await (WebhookServer.prototype as any).handleRequest.call(
      server,
      makeRequest("DELETE", "/api/v1/workflows/test"),
      res,
    );

    expect(server.workflows.deleteForTeam).toHaveBeenCalledWith("workspace-a", "test");
    expect(server.workflows.delete).not.toHaveBeenCalled();
    expect(res.writeHead).toHaveBeenCalledWith(204);
    expect(res.end).toHaveBeenCalledOnce();
  });

  it("requires authentication before reading workflows", async () => {
    const server = makeServer(null);
    const res = makeResponse();
    const req = makeRequest("GET", "/api/v1/workflows");
    req.headers.authorization = "Bearer invalid-key";

    await (WebhookServer.prototype as any).handleRequest.call(server, req, res);

    expect(res.writeHead).toHaveBeenCalledWith(401, { "Content-Type": "application/json; charset=utf-8" });
    expect(server.workflows.listForTeam).not.toHaveBeenCalled();
  });

  it("keeps the versioned publish endpoint routed through the legacy alias", async () => {
    const server = makeServer();

    await (WebhookServer.prototype as any).handleRequest.call(
      server,
      makeRequest("POST", "/api/v1/workflows/test/publish"),
      makeResponse(),
    );

    expect(server.handleWorkflowPublish).toHaveBeenCalledWith(expect.anything(), expect.anything(), "test");
  });
});
