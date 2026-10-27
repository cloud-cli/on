import { describe, expect, it } from "vitest";
import source from "./channels-ui.mjs?raw";
import router from "./app-router.mjs?raw";
import routes from "./route-table.mjs?raw";
import shell from "./app-shell.html?raw";
import { matchRoute } from "./route-table.mjs";

describe("channels UI", () => {
  it("uses cursor pagination and the authenticated API client for scoped channel APIs", () => {
    expect(source).toContain('import { apiFetch } from "@app/api-client.mjs"');
    expect(source).toContain('query.set("after", after)');
    expect(source).toContain("/api/v1/channels");
    expect(router).toContain("matchRoute(window.location.href)");
    expect(routes).toContain('pattern: "/channels"');
    expect(routes).toContain('pattern: "/workspaces/:workspaceId/channels"');
    expect(matchRoute("http://localhost/ui/workspaces/team-a/channels/channel-a")).toMatchObject({
      page: "channels",
      teamId: "team-a",
      params: { workspaceId: "team-a", channelId: "channel-a" },
    });
    expect(matchRoute("http://localhost/ui/workspaces/team-a/channels")).toMatchObject({
      page: "channels",
      teamId: "team-a",
    });
    expect(matchRoute("http://localhost/ui/workspaces/team-a/channels/channel-a").teamId).not.toBe("team-b");
    expect(source).toMatch(
      /routeParams\.workspaceId\s*\|\|\s*routeParams\.teamId\s*\|\|\s*localStorage\.getItem\("runner-team-id"\)/,
    );
    expect(source).toContain('"X-Team-ID": routedWorkspaceId');
    expect(source).toContain("selectionGeneration");
    expect(source).toContain("You're up to date.");
    expect(source).toContain("const refreshMessages = async () =>");
    expect(source).toContain("setTimeout(pollForMessages, 15_000)");
    expect(source).toContain('new URL("/api/events", window.location.href)');
    expect(source).toContain('eventUrl.searchParams.set("teamId", routedWorkspaceId)');
    expect(source).toContain('addEventListener("channel.message"');
    expect(source).toContain('addEventListener("channel.domain-event"');
    expect(source).toContain('addEventListener("open"');
    expect(source).toContain("const reconcileEvents = () =>");
    expect(source).toContain("eventResumeCursor = data.resumeCursor || after || null");
    expect(source).toContain("links.invocationIds || []");
    expect(source).toContain("/invocations/${encodeURIComponent(invocationId)}");
    expect(source).toContain("notification.channelId === selected.id");
    expect(source).toContain("drawMessages(messages, true)");
    expect(source).toContain("This channel is unavailable in the selected workspace.");
    expect(source).toContain("runner-route-changed");
    expect(source).toContain('history.pushState(null, "", target)');
  });

  it("renders message JSON as text and exposes an accessible composer and navigation", () => {
    expect(source).toContain('"Message body"');
    expect(source).toContain("JSON message body");
    expect(source).toContain("JSON.stringify(message.body, null, 2)");
    expect(shell).toContain("{{ channel.name }}</a");
    expect(shell).toContain("activeSection === 'workspace-channels'");
    expect(shell).toContain('for="channel of workspaceChannels"');
    expect(shell).toContain("attr-aria-current=\"selectedChannelId === channel.id ? 'page' : null\"");
  });

  it("keeps Threads distinct from Stream history and uses scoped Thread message endpoints", () => {
    expect(source).toContain('setAttribute("aria-label", "Threads")');
    expect(source).toContain('setAttribute("aria-label", "Stream threads")');
    expect(source).toContain("/api/v1/channels/${encodeURIComponent(channel.id)}/threads");
    expect(source).toContain("/threads/${encodeURIComponent(threadId)}/messages");
    expect(source).toContain('addEventListener("channel.thread.message"');
    expect(source).toContain('setAttribute("aria-label", "Thread messages")');
    expect(source).toContain("New Stream");
  });

  it("loads saved events lazily with opaque cursor pagination and text-only rendering", () => {
    expect(source).toContain('"Event history"');
    expect(source).toContain("/api/channels/${encodeURIComponent(channelId)}/events?${query}");
    expect(source).toContain('query.set("cursor", after)');
    expect(source).toContain("data.nextCursor || null");
    expect(source).toContain("item.textContent = JSON.stringify(entry, null, 2)");
    expect(source).toContain("eventGeneration");
    expect(source).toContain("No saved events in this channel yet.");
    expect(source).toContain("Retry loading events");
    expect(source).toContain("Reload history");
    expect(source).toContain("eventMore");
    expect(source).toContain("links.messageIds");
    expect(source).toContain("/ui/runs/${encodeURIComponent(runId)}");
    expect(source).toContain("Linked message is not in the currently loaded history.");
  });
});
