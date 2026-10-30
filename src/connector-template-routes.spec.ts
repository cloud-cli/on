import { describe, expect, it, vi } from "vitest";
import { WebhookServer } from "./server.js";
import { GITHUB_PUSH_TEMPLATE } from "./connector-templates.js";

const response = () => ({ writeHead: vi.fn().mockReturnThis(), end: vi.fn(), headersSent: false }) as any;
const request = (url: string, method = "POST") => ({ url, method, headers: { host: "app.test" } }) as any;

function makeServer({ auditFails = false, authorized = true }: { auditFails?: boolean; authorized?: boolean } = {}) {
  const connectors = {
    createForWorkspace: vi.fn(
      async (workspaceId: string, id: string, name: string, sourceYaml: string, template: any) => ({
        id,
        workspaceId,
        name,
        sourceYaml,
        version: 1,
        enabled: true,
        token: `token-${id}`,
      }),
    ),
    rotateSigningSecret: vi.fn(async (workspaceId: string, id: string) => ({
      connector: { id, workspaceId },
      secret: `secret-${id}`,
    })),
    deleteForWorkspace: vi.fn(async () => true),
  };
  return {
    workflowsLoaded: Promise.resolve(),
    authorizer: {
      authenticated: vi.fn(async () => ({ principal: { subject: "human-1", kind: "human" } })),
      workspace: vi.fn(async () => (authorized ? { principal: { subject: "human-1", kind: "human" } } : null)),
    },
    oidcUsers: { preferredUsername: vi.fn(async () => "Alice") },
    readJson: vi.fn(async () => ({})),
    connectorTemplates: { get: vi.fn(async () => GITHUB_PUSH_TEMPLATE) },
    connectors,
    principals: {
      recordAudit: vi.fn(async () => {
        if (auditFails) {
          throw new Error("audit unavailable");
        }
      }),
    },
  } as any;
}

const installPath = "/api/v1/workspaces/workspace-a/connector-templates/on/github-push/versions/1/install";

describe("connector template API installation", () => {
  it("requires workspace manage capability and isolates each fresh install", async () => {
    const server = makeServer();
    const first = response();
    const second = response();
    await (WebhookServer.prototype as any).handleRequest.call(server, request(installPath), first);
    await (WebhookServer.prototype as any).handleRequest.call(server, request(installPath), second);

    expect(server.authorizer.workspace).toHaveBeenCalledWith(
      expect.anything(),
      first,
      "webhooks.manage",
      "workspace-a",
    );
    const firstId = server.connectors.createForWorkspace.mock.calls[0][1];
    const secondId = server.connectors.createForWorkspace.mock.calls[1][1];
    expect(firstId).toMatch(/^[0-9a-f]{32}$/);
    expect(secondId).toMatch(/^[0-9a-f]{32}$/);
    expect(firstId).not.toBe(secondId);
    expect(server.connectors.createForWorkspace.mock.calls[0]).toEqual([
      "workspace-a",
      firstId,
      "GitHub push",
      GITHUB_PUSH_TEMPLATE.sourceYaml,
      { namespace: "on", slug: "github-push", version: 1 },
    ]);
    const result = JSON.parse(first.end.mock.calls[0][0]);
    expect(result.connector).not.toHaveProperty("token");
    expect(result.connector).not.toHaveProperty("signingSecret");
    expect(result.url).toContain("token-");
    expect(result.signingSecret).toBe(`secret-${firstId}`);
  });

  it("deletes a newly created connector when post-create audit fails", async () => {
    const server = makeServer({ auditFails: true });
    const res = response();
    await (WebhookServer.prototype as any).handleRequest.call(server, request(installPath), res);
    const id = server.connectors.createForWorkspace.mock.calls[0][1];
    expect(server.connectors.deleteForWorkspace).toHaveBeenCalledWith("workspace-a", id);
    expect(res.writeHead).toHaveBeenCalledWith(422, expect.anything());
  });

  it("does not create connectors when workspace authorization fails", async () => {
    const server = makeServer({ authorized: false });
    const res = response();
    await (WebhookServer.prototype as any).handleRequest.call(server, request(installPath), res);
    expect(server.connectors.createForWorkspace).not.toHaveBeenCalled();
  });

  it("publishes only for humans using the identity-derived namespace", async () => {
    const server = makeServer();
    server.connectorTemplates.namespaceForOwner = vi.fn(async () => "alice");
    server.connectorTemplates.publish = vi.fn(async () => ({
      namespace: "alice",
      slug: "normalized-hook",
      version: 1,
      name: "Normalized hook",
      description: "Normalize a webhook.",
      sourceYaml: "run: |\n  emit('hook.received', inputs)",
    }));
    server.authenticate = vi.fn(async () => ({ principal: { subject: "human-1", kind: "human" } }));
    server.readJson.mockResolvedValue({
      slug: "normalized-hook",
      name: "Normalized hook",
      description: "Normalize a webhook.",
      sourceYaml: "run: |\n  emit('hook.received', inputs)",
    });
    const res = response();
    await (WebhookServer.prototype as any).handleRequest.call(server, request("/api/v1/connector-templates"), res);
    expect(server.connectorTemplates.namespaceForOwner).toHaveBeenCalledWith("human-1", "Alice");
    expect(server.connectorTemplates.publish).toHaveBeenCalledWith(
      "alice",
      "human-1",
      "normalized-hook",
      "Normalized hook",
      "Normalize a webhook.",
      "run: |\n  emit('hook.received', inputs)",
    );
    expect(res.writeHead).toHaveBeenCalledWith(201, expect.anything());

    server.authenticate.mockResolvedValue({ principal: { subject: "agent-1", kind: "agent" } });
    const denied = response();
    await (WebhookServer.prototype as any).handleRequest.call(server, request("/api/v1/connector-templates"), denied);
    expect(server.connectorTemplates.publish).toHaveBeenCalledOnce();
    expect(denied.writeHead).toHaveBeenCalledWith(403, expect.anything());
  });

  it("deletes an install if rotating its signing secret fails after create", async () => {
    const server = makeServer();
    server.connectors.rotateSigningSecret.mockRejectedValueOnce(new Error("secret storage failed"));
    const res = response();
    await (WebhookServer.prototype as any).handleRequest.call(server, request(installPath), res);
    const id = server.connectors.createForWorkspace.mock.calls[0][1];
    expect(server.connectors.deleteForWorkspace).toHaveBeenCalledWith("workspace-a", id);
    expect(res.writeHead).toHaveBeenCalledWith(422, expect.anything());
  });

  it("reports failed cleanup instead of silently leaving a possible orphan", async () => {
    const server = makeServer({ auditFails: true });
    server.connectors.deleteForWorkspace.mockRejectedValueOnce(new Error("database unavailable"));
    const res = response();
    await (WebhookServer.prototype as any).handleRequest.call(server, request(installPath), res);
    expect(res.writeHead).toHaveBeenCalledWith(500, expect.anything());
    expect(JSON.parse(res.end.mock.calls[0][0]).error).toContain("could not be cleaned up");
  });
});
