import { describe, expect, it, vi } from "vitest";
import { WebhookServer } from "./server.js";

const response = () => ({ writeHead: vi.fn().mockReturnThis(), end: vi.fn(), headersSent: false }) as any;

function makeServer(allowed = true, job: any = { id: 7 }) {
  return {
    workflowsLoaded: Promise.resolve(),
    handleStepAttempts: (WebhookServer.prototype as any).handleStepAttempts,
    requireWorkspaceCapability: vi.fn(async (_req, res) => {
      if (!allowed) {
        res.writeHead(403, { "Content-Type": "application/json" });
        res.end();
        return null;
      }
      return { teamId: "team-a" };
    }),
    queue: {
      getJobForTeam: vi.fn(async (teamId: string, jobId: string) =>
        teamId === "team-a" && jobId === "7" ? job : null,
      ),
      getStepAttemptsForTeam: vi.fn(async () => [
        { step_id: "build", attempt: 1, status: "failed", log_content: "redacted" },
      ]),
    },
    currentSecrets: vi.fn(async () => ({})),
    redactStructured: vi.fn((value) => value),
  } as any;
}

async function request(server: any, res = response()) {
  await WebhookServer.prototype.handleRequest.call(
    server,
    { method: "GET", url: "/api/v1/jobs/7/step-attempts", headers: { host: "app.test" } } as any,
    res,
  );
  return res;
}

describe("GET /api/v1/jobs/:id/step-attempts", () => {
  it("requires runs.view and returns only attempts for the authorized workspace job", async () => {
    const server = makeServer();
    const res = await request(server);
    expect(server.requireWorkspaceCapability).toHaveBeenCalledWith(expect.anything(), expect.anything(), "runs.logs");
    expect(server.queue.getJobForTeam).toHaveBeenCalledWith("team-a", "7");
    expect(server.queue.getStepAttemptsForTeam).toHaveBeenCalledWith("team-a", "7");
    expect(JSON.parse(res.end.mock.calls[0][0])).toMatchObject({ jobId: "7", attempts: [{ step_id: "build" }] });

    const denied = await request(makeServer(false));
    expect(denied.writeHead).toHaveBeenCalledWith(403, expect.any(Object));
  });

  it("returns 404 for a missing or foreign job before loading attempts", async () => {
    const server = makeServer(true, null);
    const res = await request(server);
    expect(res.writeHead).toHaveBeenCalledWith(404, expect.any(Object));
    expect(server.queue.getStepAttemptsForTeam).not.toHaveBeenCalled();
  });
});
