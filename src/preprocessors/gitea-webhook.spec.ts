import crypto from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import { GiteaPreprocessor } from "./gitea.js";
import { WebhookServer } from "../server.js";

const response = () => ({ writeHead: vi.fn().mockReturnThis(), end: vi.fn(), headersSent: false }) as any;

describe("Gitea webhook event admission", () => {
  it("publishes a verified push through the same durable event fanout as other connectors", async () => {
    const secret = "gitea-webhook-secret";
    const rawBuffer = Buffer.from(
      JSON.stringify({
        ref: "refs/heads/main",
        after: "commit-123",
        repository: { full_name: "team/project", name: "project", owner: { login: "team" } },
        head_commit: { id: "commit-123", timestamp: "2026-01-02T03:04:05Z" },
      }),
    );
    const headers = {
      "x-gitea-event": "push",
      "x-gitea-delivery": "delivery-123",
      "x-gitea-signature": crypto.createHmac("sha256", secret).update(rawBuffer).digest("hex"),
    };
    const connector = new GiteaPreprocessor();
    const parsed = connector.parse(headers, rawBuffer, secret);
    const published = { id: "domain-event-123" };
    const server = {
      workflowsLoaded: Promise.resolve(),
      readRequest: vi.fn(async () => ({ rawBuffer, headers })),
      preprocess: vi.fn(async () => ({ ...parsed, secretValues: {} })),
      preprocessors: new Map([["gitea", connector]]),
      incomingEvents: {
        capture: vi.fn(async () => "receipt-123"),
        receivedAtForTeam: vi.fn(async () => "2026-01-03T00:00:00.000Z"),
        finish: vi.fn(async () => {}),
      },
      domainEventRepository: { publish: vi.fn(async () => published) },
      domainEventDeliveryRepository: { fanout: vi.fn(async () => ({ status: "matched", deliveryCount: 1 })) },
      matchWorkflows: vi.fn(async () => []),
      workflows: { publishedForTeam: vi.fn(async () => []) },
    };
    const res = response();

    await (WebhookServer.prototype as any).handleWebhook.call(server, "gitea", {}, res, "team-a", secret);

    expect(server.domainEventRepository.publish).toHaveBeenCalledWith(
      "team-a",
      expect.objectContaining({
        type: "git.push",
        source: "connector/gitea",
        idempotencyKey: "gitea:delivery:delivery-123",
        data: { repository: "team/project", owner: "team", name: "project", ref: "refs/heads/main", commit: "commit-123", operation: "push" },
      }),
    );
    expect(server.domainEventDeliveryRepository.fanout).toHaveBeenCalledWith("team-a", published.id);
    expect(JSON.parse(res.end.mock.calls[0][0])).toMatchObject({ message: "OK", queuedJobs: 0 });
  });
});
