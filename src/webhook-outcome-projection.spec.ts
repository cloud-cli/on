import { afterEach, describe, expect, it, vi } from "vitest";
import { WebhookServer } from "./server.js";

const response = () => ({ writeHead: vi.fn().mockReturnThis(), end: vi.fn(), headersSent: false }) as any;

function createServer({
  valid = true,
  jobs = [42],
  fanout = { status: "matched", deliveryCount: 1 },
  normalize = true,
}: {
  valid?: boolean;
  jobs?: number[];
  fanout?: { status: string; deliveryCount: number };
  normalize?: boolean;
} = {}) {
  const published = { id: "domain-event-1" };
  const connector = normalize ? { toDomainEvent: vi.fn(() => ({ type: "git.push", schemaVersion: 1, data: {} })) } : {};
  const incomingEvents = {
    capture: vi.fn(async () => "receipt-1"),
    receivedAtForTeam: vi.fn(async () => "2026-10-27T00:00:00.000Z"),
    finish: vi.fn(async () => {}),
  };
  const domainEventDeliveryRepository = { fanout: vi.fn(async () => fanout) };
  const domainEventRepository = { publish: vi.fn(async () => published) };
  const server = {
    workflowsLoaded: Promise.resolve(),
    readRequest: vi.fn(async () => ({ rawBuffer: Buffer.from("{}"), headers: { "x-provider-event": "push" } })),
    preprocess: vi.fn(async () => ({ isValid: valid, inputs: { event: "push" }, secretValues: {} })),
    preprocessors: new Map([["test", connector]]),
    incomingEvents,
    domainEventRepository,
    domainEventDeliveryRepository,
    matchWorkflows: vi.fn(async () => jobs),
    workflows: { publishedForTeam: vi.fn(async () => []) },
  };
  return { server, incomingEvents, domainEventDeliveryRepository, domainEventRepository, connector };
}

afterEach(() => vi.restoreAllMocks());

async function handle(server: object) {
  const res = response();
  await (WebhookServer.prototype as any).handleWebhook.call(server, "test", {}, res, "team-a", "secret");
  return res;
}

describe("webhook receipt and normalized-event outcome compatibility", () => {
  it("keeps legacy queued receipt status when both legacy and normalized routing match", async () => {
    const fixture = createServer({ jobs: [42] });
    const res = await handle(fixture.server);

    expect(fixture.incomingEvents.finish).toHaveBeenCalledWith(
      "team-a",
      "receipt-1",
      "valid",
      "queued",
      { event: "push" },
      [42],
    );
    expect(fixture.domainEventDeliveryRepository.fanout).toHaveBeenCalledWith("team-a", "domain-event-1");
    expect(res.writeHead).toHaveBeenCalledWith(202, expect.any(Object));
    expect(JSON.parse(res.end.mock.calls[0][0])).toMatchObject({ eventId: "receipt-1", queuedJobs: 1 });
  });

  it("keeps legacy unmatched receipt when only normalized routing matches", async () => {
    const fixture = createServer({ jobs: [] });
    const res = await handle(fixture.server);

    expect(fixture.domainEventDeliveryRepository.fanout).toHaveBeenCalledOnce();
    expect(fixture.incomingEvents.finish).toHaveBeenCalledWith(
      "team-a",
      "receipt-1",
      "valid",
      "unmatched",
      { event: "push" },
      [],
    );
    expect(res.writeHead).toHaveBeenCalledWith(202, expect.any(Object));
    expect(JSON.parse(res.end.mock.calls[0][0])).toMatchObject({ queuedJobs: 0 });
  });

  it("keeps legacy queued receipt when normalized routing is unmatched", async () => {
    const fixture = createServer({ jobs: [42], fanout: { status: "unmatched", deliveryCount: 0 } });
    const res = await handle(fixture.server);

    expect(fixture.incomingEvents.finish).toHaveBeenCalledWith(
      "team-a",
      "receipt-1",
      "valid",
      "queued",
      { event: "push" },
      [42],
    );
    expect(res.writeHead).toHaveBeenCalledWith(202, expect.any(Object));
    expect(JSON.parse(res.end.mock.calls[0][0])).toMatchObject({ queuedJobs: 1 });
  });

  it("accepts a verified receipt with neither legacy nor normalized matches", async () => {
    const fixture = createServer({ jobs: [], fanout: { status: "unmatched", deliveryCount: 0 } });
    const res = await handle(fixture.server);

    expect(fixture.incomingEvents.finish).toHaveBeenCalledWith(
      "team-a",
      "receipt-1",
      "valid",
      "unmatched",
      { event: "push" },
      [],
    );
    expect(res.writeHead).toHaveBeenCalledWith(202, expect.any(Object));
  });

  it("marks post-capture normalization failure without claiming prior writes were rolled back", async () => {
    const fixture = createServer();
    vi.spyOn(console, "error").mockImplementation(() => {});
    fixture.domainEventDeliveryRepository.fanout.mockRejectedValueOnce(new Error("fanout unavailable"));
    const res = await handle(fixture.server);

    expect(fixture.domainEventRepository.publish).toHaveBeenCalledOnce();
    expect(fixture.incomingEvents.finish).toHaveBeenCalledWith(
      "team-a",
      "receipt-1",
      "valid",
      "failed",
      { event: "push" },
      [],
      "fanout unavailable",
    );
    expect(res.writeHead).toHaveBeenCalledWith(500, expect.any(Object));
  });

  it("rejects invalid signatures before capturing any receipt", async () => {
    const fixture = createServer({ valid: false });
    const res = await handle(fixture.server);

    expect(fixture.incomingEvents.capture).not.toHaveBeenCalled();
    expect(fixture.incomingEvents.finish).not.toHaveBeenCalled();
    expect(res.writeHead).toHaveBeenCalledWith(401, expect.any(Object));
  });

  it("preserves legacy routing when a provider has no normalized-event adapter", async () => {
    const fixture = createServer({ jobs: [42], normalize: false });
    const res = await handle(fixture.server);

    expect(fixture.incomingEvents.receivedAtForTeam).not.toHaveBeenCalled();
    expect(fixture.domainEventRepository.publish).not.toHaveBeenCalled();
    expect(fixture.server.matchWorkflows).toHaveBeenCalledOnce();
    expect(fixture.incomingEvents.finish).toHaveBeenCalledWith(
      "team-a",
      "receipt-1",
      "valid",
      "queued",
      { event: "push" },
      [42],
    );
    expect(JSON.parse(res.end.mock.calls[0][0])).toMatchObject({ queuedJobs: 1 });
  });
});
