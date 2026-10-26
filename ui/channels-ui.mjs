import { apiFetch } from "@app/api-client.mjs";

const element = (tag, text, className) => {
  const node = document.createElement(tag);
  if (text !== undefined) {
    node.textContent = text;
  }
  if (className) {
    node.className = className;
  }
  return node;
};

export function mountChannels(root) {
  root.className = "mx-auto w-full max-w-6xl space-y-5 py-6";
  root.setAttribute("aria-labelledby", "channels-title");
  const heading = element("h1", "Streams", "text-2xl font-semibold");
  heading.id = "channels-title";
  const layout = element("div", undefined, "grid gap-5 md:grid-cols-[minmax(14rem,0.35fr)_minmax(0,1fr)]");
  const sidebar = element(
    "section",
    undefined,
    "min-w-0 space-y-3 rounded-xl border border-app-border bg-app-card p-4",
  );
  sidebar.setAttribute("aria-label", "Streams");
  const form = document.createElement("form");
  form.className = "flex gap-2";
  const name = document.createElement("input");
  name.name = "name";
  name.maxLength = 120;
  name.required = true;
  name.placeholder = "New Stream";
  name.setAttribute("aria-label", "New Stream name");
  name.className = "min-w-0 flex-1 rounded-lg border border-app-border px-3 py-2";
  const create = element("button", "Create", "rounded-lg bg-app-primary px-3 py-2 text-sm font-semibold text-white");
  form.append(name, create);
  const channelsList = element("ul", undefined, "space-y-1");
  channelsList.setAttribute("aria-label", "Available Streams");
  sidebar.append(form, channelsList);
  const conversation = element(
    "section",
    undefined,
    "min-w-0 space-y-4 rounded-xl border border-app-border bg-app-card p-4",
  );
  conversation.setAttribute("aria-label", "Channel transcript");
  const title = element("h2", "Select a channel", "min-w-0 break-all text-lg font-semibold");
  const eventHistory = document.createElement("details");
  eventHistory.className = "min-w-0 rounded-lg border border-app-border p-3";
  eventHistory.hidden = true;
  const eventSummary = element(
    "summary",
    "Event history",
    "min-h-11 cursor-pointer py-2 font-semibold focus-visible:ring-2 focus-visible:ring-app-primary",
  );
  const eventStatus = element("p", "", "text-sm text-app-secondary");
  eventStatus.setAttribute("role", "status");
  const eventList = element("ol", undefined, "space-y-2");
  const eventActions = element("div", undefined, "flex flex-wrap gap-2");
  const eventRetry = element(
    "button",
    "Retry loading events",
    "min-h-11 rounded-lg border border-app-border px-3 py-2 text-sm focus-visible:ring-2 focus-visible:ring-app-primary",
  );
  eventRetry.type = "button";
  eventRetry.hidden = true;
  const eventReload = element(
    "button",
    "Reload history",
    "min-h-11 rounded-lg border border-app-border px-3 py-2 text-sm focus-visible:ring-2 focus-visible:ring-app-primary",
  );
  eventReload.type = "button";
  const eventMore = element(
    "button",
    "Load more events",
    "min-h-11 rounded-lg border border-app-border px-3 py-2 text-sm focus-visible:ring-2 focus-visible:ring-app-primary",
  );
  eventMore.type = "button";
  eventMore.hidden = true;
  eventActions.append(eventRetry, eventReload, eventMore);
  eventHistory.append(eventSummary, eventStatus, eventList, eventActions);
  const threadsSection = element("section", undefined, "min-w-0 space-y-3 rounded-lg border border-app-border p-3");
  threadsSection.setAttribute("aria-label", "Threads");
  const threadsHeading = element("h3", "Threads", "font-semibold");
  const threadForm = document.createElement("form");
  threadForm.className = "flex gap-2";
  const threadTitle = document.createElement("input");
  threadTitle.name = "title";
  threadTitle.maxLength = 160;
  threadTitle.required = true;
  threadTitle.placeholder = "New thread";
  threadTitle.setAttribute("aria-label", "New thread title");
  threadTitle.className = "min-w-0 flex-1 rounded-lg border border-app-border px-3 py-2";
  const createThreadButton = element(
    "button",
    "Create thread",
    "rounded-lg border border-app-border px-3 py-2 text-sm",
  );
  threadForm.append(threadTitle, createThreadButton);
  const threadList = element("ul", undefined, "space-y-1");
  threadList.setAttribute("aria-label", "Stream threads");
  const threadStatus = element("p", "Select a Stream to view its threads.", "text-sm text-app-secondary");
  threadStatus.setAttribute("role", "status");
  const threadTranscript = element("ol", undefined, "max-h-[40vh] space-y-2 overflow-auto");
  threadTranscript.setAttribute("aria-label", "Thread messages");
  threadTranscript.hidden = true;
  const threadComposer = document.createElement("form");
  threadComposer.className = "space-y-2 border-t border-app-border pt-3";
  threadComposer.hidden = true;
  const threadPayload = document.createElement("textarea");
  threadPayload.rows = 3;
  threadPayload.required = true;
  threadPayload.placeholder = '{"text":"Reply"}';
  threadPayload.setAttribute("aria-label", "Thread message JSON body");
  threadPayload.className = "w-full rounded-lg border border-app-border p-3 font-mono text-sm";
  const sendThreadMessage = element(
    "button",
    "Reply",
    "rounded-lg bg-app-primary px-4 py-2 text-sm font-semibold text-white",
  );
  threadComposer.append(threadPayload, sendThreadMessage);
  threadsSection.append(threadsHeading, threadStatus, threadList, threadForm, threadTranscript, threadComposer);
  const status = element("p", "Loading channels…", "text-sm text-app-secondary");
  status.setAttribute("role", "status");
  status.setAttribute("aria-live", "polite");
  const transcript = element("ol", undefined, "max-h-[55vh] space-y-3 overflow-auto");
  transcript.setAttribute("aria-label", "Messages");
  transcript.tabIndex = 0;
  const more = element("button", "Load newer messages", "rounded-lg border border-app-border px-3 py-2 text-sm");
  more.type = "button";
  more.hidden = true;
  const refresh = element("button", "Check for new messages", "rounded-lg border border-app-border px-3 py-2 text-sm");
  refresh.type = "button";
  refresh.hidden = true;
  const composer = document.createElement("form");
  composer.className = "space-y-2 border-t border-app-border pt-4";
  const payload = document.createElement("textarea");
  payload.required = true;
  payload.rows = 5;
  payload.value = "";
  payload.placeholder = '{\n  "text": "Hello"\n}';
  payload.setAttribute("aria-label", "JSON message body");
  payload.setAttribute("aria-describedby", "json-help");
  payload.className = "w-full rounded-lg border border-app-border p-3 font-mono text-sm";
  const help = element(
    "p",
    "Enter a JSON value. Do not include passwords, tokens, secrets, credentials, or authorization data.",
    "text-xs text-app-secondary",
  );
  help.id = "json-help";
  const send = element(
    "button",
    "Send message",
    "rounded-lg bg-app-primary px-4 py-2 text-sm font-semibold text-white disabled:opacity-50",
  );
  composer.append(help, payload, send);
  composer.hidden = true;
  conversation.append(title, threadsSection, eventHistory, status, transcript, more, refresh, composer);
  layout.append(sidebar, conversation);
  root.replaceChildren(heading, layout);

  let selected = null;
  let selectedThread = null;
  let cursor = null;
  let latestMessageId = null;
  let selectionGeneration = 0;
  let activeMessageRequest = null;
  let canEdit = false;
  let disposed = false;
  let pollTimer = null;
  let channelEvents = null;
  let removalObserver = null;
  let eventCursor = null;
  let eventResumeCursor = null;
  let eventFailedCursor = null;
  let eventRequest = null;
  let eventRefreshPending = false;
  let eventGeneration = 0;
  const request = async (url, options) => {
    const { headers: requestHeaders, ...requestOptions } = options || {};
    const response = await apiFetch(url, {
      ...requestOptions,
      headers: {
        accept: "application/json",
        "content-type": "application/json",
        ...(root.dataset.workspaceId ? { "X-Team-ID": root.dataset.workspaceId } : {}),
        ...requestHeaders,
      },
    });
    const data = await response.json().catch(() => ({}));
    if (!response.ok) {
      throw new Error(data.error || `Request failed (${response.status})`);
    }
    return data;
  };
  const drawMessages = (messages, append = false) => {
    const existing = append
      ? new Set([...transcript.querySelectorAll("[data-message-id]")].map((node) => node.dataset.messageId))
      : new Set();
    const items = messages
      .filter((message) => !existing.has(message.id))
      .map((message) => {
        const item = element("li", undefined, "min-w-0 rounded-lg bg-app-panel p-3");
        item.dataset.messageId = message.id;
        item.id = `message-${message.id}`;
        const metadata = element(
          "p",
          `${message.author || "Member"} · ${message.createdAt || ""}`,
          "text-xs text-app-secondary",
        );
        item.append(metadata);
        const body = element(
          "pre",
          typeof message.body === "string" ? message.body : JSON.stringify(message.body, null, 2),
          "mt-2 max-h-64 min-w-0 overflow-auto whitespace-pre-wrap break-all text-sm text-app-foreground",
        );
        body.setAttribute("aria-label", "Message body");
        item.append(body);
        return item;
      });
    if (append) {
      transcript.append(...items);
    } else {
      transcript.replaceChildren(...items);
    }
  };
  const loadMessages = async (after) => {
    if (!selected) {
      return;
    }
    const channelId = selected.id;
    const generation = selectionGeneration;
    if (activeMessageRequest?.generation === generation) {
      return;
    }
    const requestToken = { generation };
    activeMessageRequest = requestToken;
    more.disabled = true;
    status.textContent = after ? "Loading more messages…" : "Loading messages…";
    try {
      const query = new URLSearchParams({ limit: "50" });
      if (after) {
        query.set("after", after);
      }
      const data = await request(`/api/v1/channels/${encodeURIComponent(channelId)}/messages?${query}`);
      if (generation !== selectionGeneration || selected?.id !== channelId) {
        return;
      }
      drawMessages(data.messages || [], Boolean(after));
      cursor = data.next || null;
      if (data.messages?.length) {
        const renderedMessages = transcript.querySelectorAll("[data-message-id]");
        latestMessageId = renderedMessages[renderedMessages.length - 1]?.dataset.messageId || latestMessageId;
      }
      more.hidden = !cursor;
      refresh.hidden = !selected;
      status.setAttribute("role", "status");
      status.textContent = data.messages?.length
        ? ""
        : after
          ? "You're up to date."
          : "No messages in this channel yet.";
    } catch (error) {
      if (generation !== selectionGeneration || selected?.id !== channelId) {
        return;
      }
      status.textContent = error.message || "Unable to load messages.";
      status.setAttribute("role", "alert");
    } finally {
      if (activeMessageRequest === requestToken) {
        activeMessageRequest = null;
        more.disabled = false;
      }
    }
  };
  const loadThreadMessages = async () => {
    if (!selected || !selectedThread) {
      return;
    }
    const channelId = selected.id;
    const threadId = selectedThread.id;
    const generation = selectionGeneration;
    threadStatus.textContent = "Loading thread messages…";
    try {
      const data = await request(
        `/api/v1/channels/${encodeURIComponent(channelId)}/threads/${encodeURIComponent(threadId)}/messages?limit=100`,
      );
      if (generation !== selectionGeneration || selectedThread?.id !== threadId) {
        return;
      }
      threadTranscript.replaceChildren(
        ...(data.messages || []).map((message) => {
          const item = element("li", undefined, "rounded-lg bg-app-panel p-3");
          item.append(
            element("p", `${message.author || "Member"} · ${message.createdAt || ""}`, "text-xs text-app-secondary"),
          );
          item.append(
            element(
              "pre",
              typeof message.body === "string" ? message.body : JSON.stringify(message.body, null, 2),
              "mt-2 whitespace-pre-wrap break-all text-sm",
            ),
          );
          return item;
        }),
      );
      threadTranscript.hidden = false;
      threadComposer.hidden = !canEdit;
      threadStatus.textContent = data.messages?.length ? "" : "No messages in this thread yet.";
    } catch (error) {
      if (generation === selectionGeneration && selectedThread?.id === threadId) {
        threadStatus.textContent = error.message || "Unable to load thread messages.";
      }
    }
  };
  const selectThread = async (thread) => {
    selectedThread = thread;
    threadTranscript.replaceChildren();
    threadTranscript.hidden = false;
    for (const button of threadList.querySelectorAll("button")) {
      button.setAttribute("aria-pressed", String(button.dataset.id === thread.id));
    }
    await loadThreadMessages();
  };
  const loadThreads = async (channel) => {
    selectedThread = null;
    threadTranscript.replaceChildren();
    threadTranscript.hidden = true;
    threadComposer.hidden = true;
    threadStatus.textContent = "Loading threads…";
    try {
      const data = await request(`/api/v1/channels/${encodeURIComponent(channel.id)}/threads`);
      if (selected?.id !== channel.id) {
        return;
      }
      const threads = data.threads || [];
      threadList.replaceChildren(
        ...threads.map((thread) => {
          const item = document.createElement("li");
          const button = element(
            "button",
            thread.title,
            "w-full rounded-lg px-3 py-2 text-left text-sm hover:bg-app-panel",
          );
          button.type = "button";
          button.dataset.id = thread.id;
          button.setAttribute("aria-pressed", "false");
          button.addEventListener("click", () => void selectThread(thread));
          item.append(button);
          return item;
        }),
      );
      threadForm.hidden = !canEdit;
      threadStatus.textContent = threads.length
        ? "Choose a thread to open the conversation."
        : "No threads in this Stream yet.";
    } catch (error) {
      if (selected?.id === channel.id) {
        threadStatus.textContent = error.message || "Unable to load threads.";
      }
    }
  };
  const loadEvents = async (after = null, reset = false) => {
    if (!selected || eventRequest) {
      return;
    }
    const channelId = selected.id;
    const generation = eventGeneration;
    const token = {};
    eventRequest = token;
    eventMore.disabled = true;
    eventStatus.setAttribute("role", "status");
    eventStatus.textContent = "Loading events…";
    try {
      const query = new URLSearchParams({ limit: "50" });
      if (after) {
        query.set("cursor", after);
      }
      const data = await request(`/api/channels/${encodeURIComponent(channelId)}/events?${query}`);
      if (generation !== eventGeneration || selected?.id !== channelId) {
        return;
      }
      const existing = reset
        ? new Set()
        : new Set([...eventList.querySelectorAll("[data-event-id]")].map((node) => node.dataset.eventId));
      const items = (data.events || [])
        .filter((entry) => !existing.has(String(entry.id)))
        .map((entry) => {
          const item = element(
            "li",
            undefined,
            "min-w-0 whitespace-pre-wrap break-all rounded-lg bg-app-panel p-3 text-sm",
          );
          item.dataset.eventId = String(entry.id);
          item.id = `event-${entry.id}`;
          item.textContent = JSON.stringify(entry, null, 2);
          const links = entry.links || {};
          const targets = element("div", undefined, "mt-2 flex flex-wrap gap-3");
          for (const messageId of links.messageIds || []) {
            const link = element("a", `Message ${messageId}`, "underline focus-visible:ring-2");
            link.href = `#message-${encodeURIComponent(messageId)}`;
            link.addEventListener("click", (click) => {
              click.preventDefault();
              const message = [...transcript.querySelectorAll("[data-message-id]")].find(
                (node) => node.dataset.messageId === messageId,
              );
              if (message) {
                message.scrollIntoView({ behavior: "smooth", block: "center" });
              } else {
                eventStatus.textContent = "Linked message is not in the currently loaded history.";
              }
            });
            targets.append(link);
          }
          for (const runId of links.runIds || []) {
            const link = element("a", `Run ${runId}`, "underline focus-visible:ring-2");
            link.href = `/ui/runs/${encodeURIComponent(runId)}`;
            targets.append(link);
          }
          for (const invocationId of links.invocationIds || []) {
            const workspaceId = root.dataset.workspaceId || localStorage.getItem("runner-team-id") || "";
            const link = element("a", `Invocation ${invocationId}`, "underline focus-visible:ring-2");
            link.href = `/ui/workspaces/${encodeURIComponent(workspaceId)}/invocations/${encodeURIComponent(invocationId)}`;
            targets.append(link);
          }
          if (links.causationEventId) {
            const link = element("a", `Caused by event ${links.causationEventId}`, "underline focus-visible:ring-2");
            link.href = `#event-${encodeURIComponent(links.causationEventId)}`;
            link.addEventListener("click", (click) => {
              click.preventDefault();
              const cause = [...eventList.querySelectorAll("[data-event-id]")].find(
                (node) => node.dataset.eventId === links.causationEventId,
              );
              if (cause) {
                cause.scrollIntoView({ behavior: "smooth", block: "center" });
              } else {
                eventStatus.textContent = "Causing event is not in the loaded history.";
              }
            });
            targets.append(link);
          }
          if (targets.childElementCount) {
            item.append(targets);
          }
          return item;
        });
      if (reset) {
        eventList.replaceChildren(...items);
      } else {
        eventList.append(...items);
      }
      eventCursor = data.nextCursor || null;
      eventResumeCursor = data.resumeCursor || after || null;
      eventFailedCursor = null;
      eventMore.hidden = !eventCursor;
      eventRetry.hidden = true;
      eventStatus.textContent =
        reset && !(data.events || []).length
          ? "No saved events in this channel yet."
          : eventCursor
            ? `${items.length} saved events loaded. Recorded order; earliest first.`
            : items.length
              ? "End of saved event history. Recorded order; earliest first."
              : "End of saved event history.";
    } catch (error) {
      if (generation === eventGeneration && selected?.id === channelId) {
        eventStatus.setAttribute("role", "alert");
        eventStatus.textContent = error.message || "Unable to load saved events.";
        eventFailedCursor = after;
        eventRetry.hidden = false;
      }
    } finally {
      if (eventRequest === token) {
        eventRequest = null;
        eventMore.disabled = false;
      }
      if (eventRefreshPending && !disposed && selected && eventHistory.open) {
        eventRefreshPending = false;
        void reconcileEvents();
      }
    }
  };
  const reconcileEvents = () => {
    if (!selected || !eventHistory.open) {
      return;
    }
    if (eventRequest) {
      eventRefreshPending = true;
      return;
    }
    void loadEvents(eventResumeCursor, eventResumeCursor === null);
  };
  const select = async (channel) => {
    selectionGeneration += 1;
    eventGeneration += 1;
    eventRequest = null;
    eventCursor = null;
    eventResumeCursor = null;
    eventFailedCursor = null;
    eventRefreshPending = false;
    eventList.replaceChildren();
    eventMore.hidden = true;
    eventStatus.textContent = "";
    eventHistory.open = false;
    selected = channel;
    selectedThread = null;
    cursor = null;
    latestMessageId = null;
    transcript.replaceChildren();
    more.hidden = true;
    refresh.hidden = true;
    title.textContent = channel.name;
    eventHistory.hidden = false;
    if (eventHistory.open) {
      void loadEvents(null, true);
    }
    composer.hidden = !canEdit;
    threadList.replaceChildren();
    threadForm.hidden = !canEdit;
    threadStatus.textContent = "Loading threads…";
    for (const button of channelsList.querySelectorAll("button")) {
      button.setAttribute("aria-pressed", String(button.dataset.id === channel.id));
      button.classList.toggle("bg-slate-100", button.dataset.id === channel.id);
      button.classList.toggle("font-semibold", button.dataset.id === channel.id);
    }
    await Promise.all([loadMessages(), loadThreads(channel)]);
  };
  const refreshMessages = async () => {
    if (!selected || activeMessageRequest) {
      return;
    }
    const channelId = selected.id;
    const generation = selectionGeneration;
    const requestToken = { generation };
    activeMessageRequest = requestToken;
    refresh.disabled = true;
    try {
      let after = latestMessageId;
      let added = 0;
      let latestPageWasFull = false;
      // Bound one refresh pass; the next poll resumes from the last appended ID.
      for (let page = 0; page < 10; page += 1) {
        const query = new URLSearchParams({ limit: "50" });
        if (after) {
          query.set("after", after);
        }
        const data = await request(`/api/v1/channels/${encodeURIComponent(channelId)}/messages?${query}`);
        if (generation !== selectionGeneration || selected?.id !== channelId) {
          return;
        }
        const messages = data.messages || [];
        if (!messages.length) {
          latestPageWasFull = false;
          break;
        }
        drawMessages(messages, true);
        added += messages.length;
        latestMessageId = messages[messages.length - 1].id;
        after = latestMessageId;
        latestPageWasFull = messages.length === 50;
        if (messages.length < 50) {
          break;
        }
      }
      if (added && cursor) {
        cursor = latestPageWasFull ? latestMessageId : null;
      }
      more.hidden = !cursor;
      if (added) {
        status.setAttribute("role", "status");
        status.textContent = `${added} new message${added === 1 ? "" : "s"} loaded.`;
      }
    } catch (error) {
      if (generation === selectionGeneration && selected?.id === channelId) {
        status.setAttribute("role", "alert");
        status.textContent = error.message || "Unable to refresh messages.";
      }
    } finally {
      if (activeMessageRequest === requestToken) {
        activeMessageRequest = null;
        refresh.disabled = false;
      }
    }
  };
  const refreshChannels = async () => {
    status.textContent = "Loading channels…";
    try {
      const data = await request("/api/v1/channels");
      canEdit = data.canEdit !== false;
      form.hidden = !canEdit;
      composer.hidden = !canEdit || !selected;
      const channels = data.channels || [];
      channelsList.replaceChildren(
        ...channels.map((channel) => {
          const li = document.createElement("li");
          const button = element(
            "button",
            channel.name,
            "w-full min-w-0 break-all rounded-lg px-3 py-2 text-left text-sm hover:bg-slate-100 focus-visible:ring-2 focus-visible:ring-app-primary",
          );
          button.type = "button";
          button.dataset.id = channel.id;
          button.setAttribute("aria-pressed", String(selected?.id === channel.id));
          if (selected?.id === channel.id) {
            button.classList.add("bg-slate-100", "font-semibold");
          }
          button.addEventListener("click", () => void select(channel));
          li.append(button);
          return li;
        }),
      );
      if (!channels.length) {
        status.textContent = "No channels yet. Create one to start a conversation.";
      } else if (!selected) {
        status.textContent = "Choose a channel to view its transcript.";
      }
      if (selected) {
        await select(channels.find((channel) => channel.id === selected.id) || channels[0]);
      }
    } catch (error) {
      status.textContent = error.message || "Unable to load channels.";
      status.setAttribute("role", "alert");
    }
  };
  form.addEventListener("submit", async (event) => {
    event.preventDefault();
    create.disabled = true;
    try {
      const data = await request("/api/v1/channels", {
        method: "POST",
        body: JSON.stringify({ name: name.value.trim() }),
      });
      name.value = "";
      await refreshChannels();
      if (data.channel) {
        await select(data.channel);
      }
    } catch (error) {
      status.textContent = error.message || "Unable to create channel.";
      status.setAttribute("role", "alert");
    } finally {
      create.disabled = false;
    }
  });
  threadForm.addEventListener("submit", async (event) => {
    event.preventDefault();
    if (!selected) {
      return;
    }
    createThreadButton.disabled = true;
    try {
      const channelId = selected.id;
      const data = await request(`/api/v1/channels/${encodeURIComponent(channelId)}/threads`, {
        method: "POST",
        body: JSON.stringify({ title: threadTitle.value.trim() }),
      });
      threadTitle.value = "";
      await loadThreads(selected);
      if (data.thread) {
        await selectThread(data.thread);
      }
    } catch (error) {
      threadStatus.textContent = error.message || "Unable to create thread.";
    } finally {
      createThreadButton.disabled = false;
    }
  });
  threadComposer.addEventListener("submit", async (event) => {
    event.preventDefault();
    if (!selected || !selectedThread) {
      return;
    }
    let body;
    try {
      body = JSON.parse(threadPayload.value);
    } catch {
      threadStatus.textContent = "Enter valid JSON before replying.";
      threadStatus.setAttribute("role", "alert");
      threadPayload.focus();
      return;
    }
    sendThreadMessage.disabled = true;
    try {
      const channelId = selected.id;
      const threadId = selectedThread.id;
      await request(
        `/api/v1/channels/${encodeURIComponent(channelId)}/threads/${encodeURIComponent(threadId)}/messages`,
        {
          method: "POST",
          body: JSON.stringify({ body }),
        },
      );
      threadPayload.value = "";
      await loadThreadMessages();
      threadStatus.setAttribute("role", "status");
      threadStatus.textContent = "Reply sent.";
    } catch (error) {
      threadStatus.setAttribute("role", "alert");
      threadStatus.textContent = error.message || "Unable to send reply.";
    } finally {
      sendThreadMessage.disabled = false;
    }
  });
  more.addEventListener("click", () => void loadMessages(cursor));
  eventSummary.addEventListener("click", () => {
    if (!eventHistory.open && selected) {
      void loadEvents(null, true);
    }
  });
  eventMore.addEventListener("click", () => void loadEvents(eventCursor));
  eventRetry.addEventListener("click", () => void loadEvents(eventFailedCursor, eventFailedCursor === null));
  eventReload.addEventListener("click", () => void loadEvents(null, true));
  refresh.addEventListener("click", () => void refreshMessages());
  composer.addEventListener("submit", async (event) => {
    event.preventDefault();
    let body;
    try {
      body = JSON.parse(payload.value);
    } catch {
      status.textContent = "Enter valid JSON before sending.";
      status.setAttribute("role", "alert");
      payload.focus();
      return;
    }
    send.disabled = true;
    try {
      const channelId = selected.id;
      const data = await request(`/api/v1/channels/${encodeURIComponent(channelId)}/messages`, {
        method: "POST",
        body: JSON.stringify({ body }),
      });
      if (selected?.id === channelId && data.message) {
        // Render our acknowledged send immediately; reconciliation may already be in flight.
        drawMessages([data.message], true);
        await refreshMessages();
      }
      payload.value = "";
      status.textContent = "Message sent.";
    } catch (error) {
      status.textContent = error.message || "Unable to send message.";
      status.setAttribute("role", "alert");
    } finally {
      send.disabled = false;
    }
  });
  void refreshChannels();
  const pollForMessages = async () => {
    if (disposed || !root.isConnected) {
      dispose();
      return;
    }
    await refreshMessages();
    if (!disposed) {
      pollTimer = setTimeout(pollForMessages, 15_000);
    }
  };
  const dispose = () => {
    if (disposed || root.isConnected) {
      return;
    }
    disposed = true;
    if (pollTimer) {
      clearTimeout(pollTimer);
      pollTimer = null;
    }
    channelEvents?.close();
    removalObserver?.disconnect();
  };
  if (typeof MutationObserver !== "undefined" && document.documentElement) {
    removalObserver = new MutationObserver(dispose);
    removalObserver.observe(document.documentElement, {
      childList: true,
      subtree: true,
    });
  }
  if (typeof EventSource !== "undefined") {
    const eventUrl = new URL("/api/events", window.location.href);
    if (root.dataset.workspaceId) {
      eventUrl.searchParams.set("teamId", root.dataset.workspaceId);
    }
    channelEvents = new EventSource(eventUrl);
    channelEvents.addEventListener("channel.message", (event) => {
      let notification;
      try {
        notification = JSON.parse(event.data);
      } catch {
        return;
      }
      // Notifications are wake-ups only; the scoped API is authoritative.
      if (!disposed && selected && notification.channelId === selected.id) {
        void refreshMessages();
      }
    });
    channelEvents.addEventListener("channel.thread.message", (event) => {
      let notification;
      try {
        notification = JSON.parse(event.data);
      } catch {
        return;
      }
      if (
        !disposed &&
        selected &&
        selectedThread &&
        notification.channelId === selected.id &&
        notification.threadId === selectedThread.id
      ) {
        void loadThreadMessages();
      }
    });
    channelEvents.addEventListener("channel.domain-event", (event) => {
      let notification;
      try {
        notification = JSON.parse(event.data);
      } catch {
        return;
      }
      if (!disposed && selected && notification.channelId === selected.id) {
        reconcileEvents();
      }
    });
    channelEvents.addEventListener("open", () => {
      // Reconcile after initial connect and every automatic reconnect to recover gaps.
      if (!disposed && selected) {
        void refreshMessages();
        reconcileEvents();
      }
    });
  }
  pollTimer = setTimeout(pollForMessages, 15_000);
}
