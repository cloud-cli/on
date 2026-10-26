import { describe, expect, it, vi } from "vitest";
import { WebhookServer } from "./server.js";

const response = () =>
  ({
    writeHead: vi.fn().mockReturnThis(),
    end: vi.fn(),
    headersSent: false,
  }) as any;

function makeServer(capabilities = ["workflows.view", "workflows.edit"]) {
  const server: any = {
    requireWorkspaceCapability: vi.fn(async (_req, res, capability) => {
      if (capabilities.includes(capability)) {
        return {
          teamId: "team-a",
          principal: { subject: "actor-a" },
          capabilities,
        };
      }
      res.writeHead(403);
      res.end();
      return null;
    }),
    channels: {
      listChannels: vi.fn(async (teamId) => [{ id: "chan", teamId, name: "activity", createdAt: "now" }]),
      getChannel: vi.fn(async (teamId) => (teamId === "team-a" ? { id: "chan" } : null)),
      createChannel: vi.fn(async (teamId, name) => ({
        id: "chan",
        teamId,
        name,
        createdAt: "now",
      })),
      listMessages: vi.fn(async () => [{ id: "msg", body: { text: "hello" } }]),
      appendMessage: vi.fn(async (input) => ({
        ...input,
        id: "msg",
        createdAt: "now",
      })),
    },
    events: { publish: vi.fn() },
    domainEventRepository: {
      listChannelEvents: vi.fn(async (...args) => ({
        events: [],
        nextCursor: null,
      })),
    },
    readJson: vi.fn(),
  };
  return server;
}

describe("workspace channel APIs", () => {
  it("lists only the authenticated workspace and requires view capability", async () => {
    const server = makeServer();
    const res = response();
    await WebhookServer.prototype.handleChannelList.call(server, {}, res);
    expect(server.channels.listChannels).toHaveBeenCalledWith("team-a");
    expect(JSON.parse(res.end.mock.calls[0][0]).teamId).toBe("team-a");
    const denied = makeServer([]);
    await WebhookServer.prototype.handleChannelList.call(denied, {}, response());
    expect(denied.channels.listChannels).not.toHaveBeenCalled();
  });

  it("derives author/workspace and rejects untrusted metadata and secret fields", async () => {
    const server = makeServer();
    const req = {};
    const res = response();
    server.readJson.mockResolvedValue({
      body: { text: "hello" },
      teamId: "other",
      author: "forged",
    });
    await WebhookServer.prototype.handleChannelMessageAppend.call(server, req, res, "chan");
    expect(server.channels.appendMessage).not.toHaveBeenCalled();
    server.readJson.mockResolvedValue({
      body: { nested: { Authorization: "secret" } },
    });
    await WebhookServer.prototype.handleChannelMessageAppend.call(server, req, response(), "chan");
    expect(server.channels.appendMessage).not.toHaveBeenCalled();
    server.readJson.mockResolvedValue({ body: { text: "hello" } });
    const accepted = response();
    await WebhookServer.prototype.handleChannelMessageAppend.call(server, req, accepted, "chan");
    expect(server.channels.appendMessage).toHaveBeenCalledWith({
      teamId: "team-a",
      channelId: "chan",
      author: "actor-a",
      body: { text: "hello" },
    });
    expect(JSON.parse(accepted.end.mock.calls[0][0]).message.author).toBe("actor-a");
    expect(server.events.publish).toHaveBeenCalledWith("channel.message", {
      teamId: "team-a",
      channelId: "chan",
      messageId: "msg",
    });
  });

  it("rejects common normalized credential-key variants in message bodies", async () => {
    const server = makeServer();
    for (const body of [
      { access_token: "hidden" },
      { client_secret: "hidden" },
      { apiKey: "hidden" },
      { nested: { "private-key": "hidden" } },
      { bearer: "hidden" },
    ]) {
      server.readJson.mockResolvedValueOnce({ body });
      const res = response();
      await WebhookServer.prototype.handleChannelMessageAppend.call(server, {}, res, "chan");
      expect(res.writeHead).toHaveBeenCalledWith(400, expect.any(Object));
    }
    expect(server.channels.appendMessage).not.toHaveBeenCalled();
  });

  it("isolates history by workspace and bounds pagination", async () => {
    const server = makeServer();
    const res = response();
    server.channels.getChannel.mockResolvedValue(null);
    await WebhookServer.prototype.handleChannelMessages.call(
      server,
      { url: "/api/channels/chan/messages?limit=5&after=cursor" },
      res,
      "chan",
    );
    expect(res.writeHead).toHaveBeenCalledWith(404, expect.anything());
    expect(server.channels.listMessages).not.toHaveBeenCalled();
    server.channels.getChannel.mockResolvedValue({ id: "chan" });
    const bad = response();
    await WebhookServer.prototype.handleChannelMessages.call(
      server,
      { url: "/api/channels/chan/messages?limit=101" },
      bad,
      "chan",
    );
    expect(bad.writeHead).toHaveBeenCalledWith(400, expect.anything());
  });

  it("pages channel events using the authenticated workspace and rejects invalid cursors", async () => {
    const server = makeServer(["workflows.view"]);
    server.domainEventRepository.listChannelEvents.mockResolvedValue({
      events: [
        {
          id: "e1",
          links: {
            messageIds: ["m1"],
            runIds: ["r1"],
            causationEventId: null,
          },
        },
      ],
      nextCursor: "next",
    });
    const res = response();
    await WebhookServer.prototype.handleChannelEvents.call(
      server,
      { url: "/api/channels/chan/events?limit=3&cursor=encoded&teamId=team-b" },
      res,
      "chan",
    );
    expect(server.domainEventRepository.listChannelEvents).toHaveBeenCalledWith("team-a", "chan", 3, "encoded");
    expect(JSON.parse(res.end.mock.calls[0][0])).toMatchObject({
      events: [
        {
          id: "e1",
          links: {
            messageIds: ["m1"],
            runIds: ["r1"],
            causationEventId: null,
          },
        },
      ],
      nextCursor: "next",
      teamId: "team-a",
    });
    server.domainEventRepository.listChannelEvents.mockRejectedValue(new Error("Invalid event cursor"));
    const invalid = response();
    await WebhookServer.prototype.handleChannelEvents.call(
      server,
      { url: "/api/channels/chan/events?cursor=bad" },
      invalid,
      "chan",
    );
    expect(invalid.writeHead).toHaveBeenCalledWith(400, expect.anything());
    const denied = makeServer([]);
    await WebhookServer.prototype.handleChannelEvents.call(
      denied,
      { url: "/api/channels/chan/events" },
      response(),
      "chan",
    );
    expect(denied.channels.getChannel).not.toHaveBeenCalled();
    expect(denied.domainEventRepository.listChannelEvents).not.toHaveBeenCalled();
    server.channels.getChannel.mockResolvedValue(null);
    const missing = response();
    await WebhookServer.prototype.handleChannelEvents.call(
      server,
      { url: "/api/channels/chan/events" },
      missing,
      "chan",
    );
    expect(missing.writeHead).toHaveBeenCalledWith(404, expect.anything());
  });
});
