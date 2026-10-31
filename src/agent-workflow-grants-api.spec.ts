import { describe, expect, it, vi } from "vitest";
import { WebhookServer } from "./server.js";

const response = () => ({ writeHead: vi.fn().mockReturnThis(), end: vi.fn(), headersSent: false }) as any;
const human = {
  subject: "human:admin",
  kind: "human",
  platformRole: "user",
  platformCapabilities: [],
  disabled: false,
};

function makeServer(teamId = "workspace-a") {
  return {
    authorizer: {
      workspace: vi.fn(async (_req: unknown, res: any) => {
        if (!teamId) {
          res.writeHead(403).end();
          return null;
        }
        return { teamId, principal: human };
      }),
    },
    readJson: vi.fn(async (req: any) => req.body),
    principals: {
      principal: vi.fn(async (id: string) =>
        id === "agent-a" ? { kind: "agent", disabled: false } : id === "human-a" ? { kind: "human" } : null,
      ),
      membership: vi.fn(
        async (team: string, id: string) => team === "workspace-a" && ["agent-a", "human-a"].includes(id),
      ),
    },
    workflows: {
      getForTeam: vi.fn(async (team: string, id: string) => (team === "workspace-a" && id === "wf" ? { id } : null)),
    },
    agentWorkflowGrantRepository: { grant: vi.fn(async () => {}), list: vi.fn(async () => []) },
  } as any;
}

async function request(server: any, body: unknown) {
  const res = response();
  await (WebhookServer.prototype as any).handleRequest.call(
    server,
    {
      method: "POST",
      url: "/api/v1/agent-workflow-grants",
      body,
      headers: { host: "app.test", "x-workspace-id": "workspace-a" },
    },
    res,
  );
  return res;
}

describe("agent workflow grant API", () => {
  it("grants only a workspace-member Agent principal access to a workflow in that workspace", async () => {
    const server = makeServer();
    const res = await request(server, { agentPrincipalId: "agent-a", workflowId: "wf" });
    expect(server.authorizer.workspace).toHaveBeenCalledWith(expect.anything(), res, "workflows.edit");
    expect(server.agentWorkflowGrantRepository.grant).toHaveBeenCalledWith(
      "workspace-a",
      "agent-a",
      "wf",
      "human:admin",
    );
    expect(res.writeHead).toHaveBeenCalledWith(201, expect.any(Object));
  });

  it("denies an Agent from another workspace and rejects non-Agent principals", async () => {
    const crossWorkspace = makeServer();
    const denied = await request(crossWorkspace, {
      agentPrincipalId: "agent-a",
      workflowId: "wf",
      teamId: "workspace-b",
    });
    expect(denied.writeHead).toHaveBeenCalledWith(404, expect.any(Object));
    expect(crossWorkspace.agentWorkflowGrantRepository.grant).not.toHaveBeenCalled();

    const nonAgent = makeServer();
    nonAgent.principals.principal.mockResolvedValue({ kind: "human", disabled: false });
    const rejected = await request(nonAgent, { agentPrincipalId: "human-a", workflowId: "wf" });
    expect(rejected.writeHead).toHaveBeenCalledWith(404, expect.any(Object));
    expect(nonAgent.agentWorkflowGrantRepository.grant).not.toHaveBeenCalled();
  });
});
