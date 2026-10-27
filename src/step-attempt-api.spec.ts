import { describe, expect, it, vi } from "vitest";
import { WebhookServer } from "./server.js";

const response = () =>
  ({
    writeHead: vi.fn().mockReturnThis(),
    end: vi.fn(),
    headersSent: false,
  }) as any;

function makeServer(allowed: boolean | string[] = true, job: any = { id: 7 }) {
  return {
    workflowsLoaded: Promise.resolve(),
    handleStepAttempts: (WebhookServer.prototype as any).handleStepAttempts,
    requireWorkspaceCapability: vi.fn(async (_req, res) => {
      if (allowed === false) {
        res.writeHead(403, { "Content-Type": "application/json" });
        res.end();
        return null;
      }
      return { teamId: "team-a", capabilities: Array.isArray(allowed) ? allowed : ["runs.logs", "runs.inputs"] };
    }),
    queue: {
      getJobForTeam: vi.fn(async (teamId: string, jobId: string) =>
        teamId === "team-a" && jobId === "7" ? job : null,
      ),
      getStepAttemptsForTeam: vi.fn(async () => [
        {
          step_id: "build",
          attempt: 1,
          status: "failed",
          log_content: "redacted",
          snapshot_json: '{"version":1,"status":"captured","inputs":{"branch":"main"}}',
        },
        {
          step_id: "test",
          attempt: 1,
          status: "interrupted_or_unknown",
          lifecycle_status: "started",
          log_content: "",
        },
        { step_id: "omitted", attempt: 1, status: "success", snapshot_json: '{"version":1,"status":"omitted"}' },
        { step_id: "invalid", attempt: 1, status: "success", snapshot_json: '{"version":2,"status":"captured"}' },
        { step_id: "missing", attempt: 1, status: "success", snapshot_json: null },
      ]),
    },
    currentSecrets: vi.fn(async () => ({})),
    redactStructured: vi.fn((value) => value),
  } as any;
}

async function request(server: any, res = response()) {
  await WebhookServer.prototype.handleRequest.call(
    server,
    {
      method: "GET",
      url: "/api/v1/jobs/7/step-attempts",
      headers: { host: "app.test" },
    } as any,
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
    expect(JSON.parse(res.end.mock.calls[0][0])).toMatchObject({
      jobId: "7",
      attempts: [
        { step_id: "build" },
        { step_id: "test", status: "interrupted_or_unknown" },
        { step_id: "omitted" },
        { step_id: "invalid" },
        { step_id: "missing" },
      ],
    });
    expect(JSON.parse(res.end.mock.calls[0][0]).attempts[0].snapshot).toMatchObject({
      version: 1,
      status: "captured",
    });
    expect(JSON.parse(res.end.mock.calls[0][0]).attempts.map((attempt) => attempt.evidenceAvailability)).toEqual([
      { status: "available", available: true },
      { status: "interrupted", available: false },
      { status: "omitted", available: false },
      { status: "invalid", available: false },
      { status: "missing", available: false },
    ]);

    const denied = await request(makeServer(false));
    expect(denied.writeHead).toHaveBeenCalledWith(403, expect.any(Object));
  });

  it("does not expose input/output snapshots to principals with log-only access", async () => {
    const res = await request(makeServer(["runs.logs"]));
    const attempts = JSON.parse(res.end.mock.calls[0][0]).attempts;
    expect(attempts[0]).not.toHaveProperty("snapshot");
    expect(attempts[0]).not.toHaveProperty("snapshot_json");
    expect(attempts[0].evidenceAvailability).toEqual({ status: "available", available: true });
  });

  it("returns 404 for a missing or foreign job before loading attempts", async () => {
    const server = makeServer(true, null);
    const res = await request(server);
    expect(res.writeHead).toHaveBeenCalledWith(404, expect.any(Object));
    expect(server.queue.getStepAttemptsForTeam).not.toHaveBeenCalled();
  });
});
