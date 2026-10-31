import { describe, expect, it } from "vitest";
import source from "./channels-ui.mjs?raw";
import router from "./app-router.mjs?raw";
import routes from "./route-table.mjs?raw";
import shell from "./app-shell.html?raw";
import { matchRoute } from "./route-table.mjs";

describe("channels UI", () => {
  it("uses cursor pagination and the authenticated API client for scoped Stream APIs", () => {
    expect(source).toContain('import { apiFetch } from "@app/api-client.mjs"');
    expect(source).toContain('query.set("after", after)');
    expect(source).toContain('request("/api/v1/streams")');
    expect(source).toContain('request("/api/v1/streams", {');
    expect(source).toContain("const channels = data.streams || []");
    expect(source).toContain("if (data.stream)");
    expect(source).toContain("/api/v1/channels/${encodeURIComponent(channelId)}/messages?");
    expect(source).not.toContain("/api/v1/streams/${encodeURIComponent(channelId)}/messages?");
    expect(source).toContain('query.set("after", after)');
    expect(source).toContain('"X-Workspace-ID": routedWorkspaceId');
    expect(source).toContain("Request failed (${response.status})");
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
    expect(source).toContain('"X-Workspace-ID": routedWorkspaceId');
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

  it("renders legacy message JSON as text and exposes plain text composers and navigation", () => {
    expect(source).toContain('"Message body"');
    expect(source).toContain("New thread message");
    expect(source).toContain("Thread reply");
    expect(source).toContain("JSON.stringify(message.body, null, 2)");
    expect(shell).toContain("{{ channel.name }}</span");
    expect(shell).toContain('class="min-w-0 truncate"');
    expect(shell).toContain("workspacePath(selectedWorkspaceId, 'channels')");
    expect(shell).toContain('for="channel of workspaceChannels"');
    expect(shell).toContain("attr-aria-current=\"selectedChannelId === channel.id ? 'page' : null\"");
  });

  it("keeps Threads distinct from Stream history and uses scoped Thread message endpoints", () => {
    expect(source).toContain('setAttribute("aria-label", "Threads")');
    expect(source).toContain('setAttribute("aria-label", "Stream threads")');
    expect(source).toContain("/api/v1/streams/${encodeURIComponent(channel.id)}/threads");
    expect(source).toContain("/api/v1/streams/${encodeURIComponent(channelId)}/threads");
    expect(source).toContain(
      "/api/v1/streams/${encodeURIComponent(channelId)}/threads/${encodeURIComponent(threadId)}/messages",
    );
    expect(source).toContain('"Load more thread messages"');
    expect(source).toContain('new URLSearchParams({ limit: "100" })');
    expect(source).toContain('query.set("after", after)');
    expect(source).toContain("threadTranscript.append(...messages)");
    expect(source).toContain("threadCursor = data.next || null");
    expect(source).toContain('addEventListener("channel.thread.message"');
    expect(source).toContain('setAttribute("aria-label", "Thread messages")');
    expect(source).toContain("New Stream");
  });

  it("provides a Thread-scoped Agent subscription control with safe status-only rendering", () => {
    expect(source).toContain('setAttribute("aria-label", "Thread Agent")');
    expect(source).toContain('setAttribute("aria-label", "Agent for this thread")');
    expect(source).toContain('"flex min-w-0 flex-col gap-2 sm:flex-row"');
    expect(source).toContain("/agent-subscriptions");
    expect(source).toContain('method: "POST"');
    expect(source).toContain("JSON.stringify({ agentPrincipalId: agentSelect.value, consent: true })");
    expect(source).toContain('method: "DELETE"');
    expect(source).toContain("(data.agents || []).filter");
    expect(source).toContain('typeof agent.principalId === "string"');
    expect(source).toContain("agent.principalId === agentSelect.value");
    expect(source).not.toContain("membersData.members");
    expect(source).toContain("Last response failed");
    expect(source).toContain("Response complete");
    expect(source).toContain("Unable to load Agent subscription.");
    expect(source).toContain("Unable to enable Agent responses.");
    expect(source).toContain("agentSelect.disabled = agentBusy");
    expect(source).toContain("enableAgent.disabled = agentBusy");
    expect(source).not.toContain("turn.error");
    expect(source).toContain("agentBusy || !selected || !selectedThread");
    expect(source).toContain("operationGeneration === agentOperationGeneration");
    expect(source).toContain("const invalidateAgentOperations = () =>");
    expect(source).toContain("invalidateAgentOperations();\n    selectedThread = thread;");
  });

  it("requires the backend disclosure and unchecked-by-default explicit consent before activation", () => {
    expect(source).toContain('typeof data.providerNotice === "string" && data.providerNotice.trim()');
    expect(source).toContain("agentProviderNotice.textContent = agentProviderNoticeText");
    expect(source).toContain("agentProviderNotice.hidden = !agentProviderNoticeText");
    expect(source).toContain('element("p", "Agent replies are saved in this Thread.", "text-sm text-app-secondary")');
    expect(source).toContain("agentConsent.checked = false");
    expect(source).toContain('agentConsent.type = "checkbox"');
    expect(source).toContain("agentConsentLabel.hidden = !agentProviderNoticeText");
    expect(source).toContain("enableAgent.hidden = Boolean(subscription) || !agentProviderNoticeText");
    expect(source).toContain("!agentProviderNoticeText ||");
    expect(source).toContain("!agentConsent.checked ||");
    expect(source).toContain("agentBusy ||");
    expect(source).toContain("agentPanel.append(");
  });

  it("loads saved events with opaque cursor pagination and text-only rendering", () => {
    expect(source).toContain('"Event history"');
    expect(source).toContain("/api/channels/${encodeURIComponent(channelId)}/events?${query}");
    expect(source).not.toContain("/api/v1/streams/${encodeURIComponent(channelId)}/events");
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
    expect(source).toContain("thread.createdAt");
    expect(source).toContain("entry.occurredAt");
    expect(source).toContain("the timeline is incomplete until all pages are loaded");
  });

  it("keeps the composer available in the selected Stream and projects linked runs inline", () => {
    expect(source).toContain(
      "conversation.append(emptyState, title, status, threadsSection, eventHistory, legacyHistory, threadForm, composer)",
    );
    expect(source).toContain("request(`/api/v1/runs/${encodeURIComponent(runId)}`)");
    expect(source).toContain('card.setAttribute("aria-label", `Run ${runId} status`)');
    expect(source).toContain('"mt-2 min-w-0 rounded-lg border border-app-border bg-app-panel p-3"');
    expect(source).toContain('element("li", undefined, "min-w-0 border-b border-app-border py-3 last:border-0")');
  });
});
