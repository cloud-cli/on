import { describe, expect, it, vi } from "vitest";
import { WebhookServer } from "./server.js";

const response = () => ({ writeHead: vi.fn().mockReturnThis(), end: vi.fn(), headersSent: false }) as any;

function makeServer(capabilities = ["workflows.view", "workflows.edit"]) {
  const server: any = {
    requireWorkspaceCapability: vi.fn(async (_req, res, capability) => {
      if (capabilities.includes(capability)) {
        return { teamId: "team-a", principal: { subject: "actor-a" }, capabilities };
      }
      res.writeHead(403);
      res.end();
      return null;
    }),
    channels: {
      listChannels: vi.fn(async (teamId) => [{ id: "chan", teamId, name: "activity", createdAt: "now" }]),
      getChannel: vi.fn(async (teamId) => (teamId === "team-a" ? { id: "chan" } : null)),
      createChannel: vi.fn(async (teamId, name) => ({ id: "chan", teamId, name, createdAt: "now" })),
      listMessages: vi.fn(async () => [{ id: "msg", body: { text: "hello" } }]),
      appendMessage: vi.fn(async (input) => ({ ...input, id: "msg", createdAt: "now" })),
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
    server.readJson.mockResolvedValue({ body: { text: "hello" }, teamId: "other", author: "forged" });
    await WebhookServer.prototype.handleChannelMessageAppend.call(server, req, res, "chan");
    expect(server.channels.appendMessage).not.toHaveBeenCalled();
    server.readJson.mockResolvedValue({ body: { nested: { Authorization: "secret" } } });
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
});
