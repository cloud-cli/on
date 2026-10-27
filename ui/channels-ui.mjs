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

export function mountChannels(root, routeParams = root.routeParams || {}) {
  const routedWorkspaceId =
    routeParams.workspaceId || routeParams.teamId || localStorage.getItem("runner-team-id") || "";
  let routedChannelId = routeParams.channelId || "";
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
  sidebar.append(channelsList);
  const conversation = element(
    "section",
    undefined,
    "min-w-0 space-y-4 rounded-xl border border-app-border bg-app-card p-4",
  );
  conversation.setAttribute("aria-label", "Channel transcript");
  const emptyState = element(
    "section",
    undefined,
    "flex min-h-[calc(100dvh-8rem)] flex-col items-center justify-center px-4 py-12 text-center",
  );
  emptyState.setAttribute("aria-labelledby", "channels-empty-title");
  emptyState.hidden = true;
  const illustration = document.createElementNS("http://www.w3.org/2000/svg", "svg");
  illustration.setAttribute("viewBox", "0 0 160 120");
  illustration.setAttribute("role", "img");
  illustration.setAttribute("aria-label", "A new conversation waiting to begin");
  illustration.classList.add("mb-6", "h-32", "w-40");
  const art = document.createElementNS("http://www.w3.org/2000/svg", "g");
  art.setAttribute("fill", "none");
  art.setAttribute("stroke", "currentColor");
  art.setAttribute("stroke-linecap", "round");
  art.setAttribute("stroke-linejoin", "round");
  art.setAttribute("stroke-width", "4");
  const artShapes = [
    [
      "rect",
      {
        x: "20",
        y: "20",
        width: "120",
        height: "78",
        rx: "16",
        class: "text-app-border",
      },
    ],
    ["path", { d: "M48 48h64M48 66h40M58 98l-12 12v-12", class: "text-app-primary" }],
    ["circle", { cx: "112", cy: "84", r: "18", class: "text-app-primary" }],
    ["path", { d: "M112 76v16M104 84h16", class: "text-app-primary" }],
  ];
  for (const [tag, attributes] of artShapes) {
    const shape = document.createElementNS("http://www.w3.org/2000/svg", tag);
    for (const [attribute, value] of Object.entries(attributes)) {
      shape.setAttribute(attribute, value);
    }
    art.append(shape);
  }
  illustration.append(art);
  const emptyTitle = element("h2", "Start your first Stream", "text-2xl font-semibold");
  emptyTitle.id = "channels-empty-title";
  const emptyCopy = element(
    "p",
    "Create a Stream to bring conversations and updates for this workspace together.",
    "mt-3 max-w-md text-app-secondary",
  );
  const emptyAction = element(
    "button",
    "Create your first Stream",
    "mt-6 min-h-11 rounded-lg bg-app-primary px-5 py-3 font-semibold text-white focus-visible:ring-2 focus-visible:ring-app-primary",
  );
  emptyAction.type = "button";
  const noPermission = element(
    "p",
    "You don’t have permission to create Streams in this workspace. Ask a workspace administrator for access.",
    "mt-5 max-w-md text-sm text-app-secondary",
  );
  noPermission.hidden = true;
  form.hidden = true;
  const cancelCreate = element("button", "Cancel", "rounded-lg border border-app-border px-4 py-2 text-sm");
  cancelCreate.type = "button";
  cancelCreate.hidden = true;
  const createError = element("p", undefined, "text-sm text-red-700");
  createError.setAttribute("role", "alert");
  createError.hidden = true;
  emptyState.append(illustration, emptyTitle, emptyCopy, emptyAction, noPermission, form, cancelCreate, createError);
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
  const threadMore = element(
    "button",
    "Load more thread messages",
    "rounded-lg border border-app-border px-3 py-2 text-sm",
  );
  threadMore.type = "button";
  threadMore.hidden = true;
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
  threadsSection.append(
    threadsHeading,
    threadStatus,
    threadList,
    threadForm,
    threadTranscript,
    threadMore,
    threadComposer,
  );
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
  conversation.append(emptyState, title, threadsSection, eventHistory, status, transcript, more, refresh, composer);
  layout.append(sidebar, conversation);
  root.replaceChildren(heading, emptyState, layout);

  let selected = null;
  let selectedThread = null;
  let threadCursor = null;
  let threadLatestMessageId = null;
  let threadRequestGeneration = 0;
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
        ...(routedWorkspaceId ? { "X-Team-ID": routedWorkspaceId } : {}),
        ...requestHeaders,
      },
    });
    const data = await response.json().catch(() => ({}));
    if (!response.ok) {
      const error = new Error(data.error || `Request failed (${response.status})`);
      error.status = response.status;
      throw error;
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
  const loadThreadMessages = async (after = null) => {
    if (!selected || !selectedThread) {
      return;
    }
    const channelId = selected.id;
    const threadId = selectedThread.id;
    const generation = selectionGeneration;
    const requestGeneration = ++threadRequestGeneration;
    const query = new URLSearchParams({ limit: "100" });
    if (after) {
      query.set("after", after);
    }
    threadMore.disabled = true;
    threadStatus.textContent = "Loading thread messages…";
    try {
      const data = await request(
        `/api/v1/streams/${encodeURIComponent(channelId)}/threads/${encodeURIComponent(threadId)}/messages?${query}`,
      );
      if (
        generation !== selectionGeneration ||
        selectedThread?.id !== threadId ||
        requestGeneration !== threadRequestGeneration
      ) {
        return;
      }
      const existingMessages = after
        ? new Set(
            [...threadTranscript.querySelectorAll("[data-thread-message-id]")].map(
              (item) => item.dataset.threadMessageId,
            ),
          )
        : new Set();
      const messages = (data.messages || [])
        .filter((message) => !existingMessages.has(message.id))
        .map((message) => {
          const item = element("li", undefined, "rounded-lg bg-app-panel p-3");
          item.dataset.threadMessageId = message.id;
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
        });
      if (after) {
        threadTranscript.append(...messages);
      } else {
        threadTranscript.replaceChildren(...messages);
      }
      const renderedMessages = threadTranscript.querySelectorAll("[data-thread-message-id]");
      threadLatestMessageId = renderedMessages[renderedMessages.length - 1]?.dataset.threadMessageId || null;
      threadCursor = data.next || null;
      threadMore.hidden = !threadCursor;
      threadTranscript.hidden = false;
      threadComposer.hidden = !canEdit;
      threadStatus.textContent = data.messages?.length ? "" : "No messages in this thread yet.";
    } catch (error) {
      if (
        generation === selectionGeneration &&
        selectedThread?.id === threadId &&
        requestGeneration === threadRequestGeneration
      ) {
        threadStatus.textContent = error.message || "Unable to load thread messages.";
      }
    } finally {
      if (requestGeneration === threadRequestGeneration) {
        threadMore.disabled = false;
      }
    }
  };
  const selectThread = async (thread) => {
    selectedThread = thread;
    threadCursor = null;
    threadLatestMessageId = null;
    threadMore.hidden = true;
    threadTranscript.replaceChildren();
    threadTranscript.hidden = false;
    for (const button of threadList.querySelectorAll("button")) {
      button.setAttribute("aria-pressed", String(button.dataset.id === thread.id));
    }
    await loadThreadMessages();
  };
  threadMore.addEventListener("click", () => {
    if (threadCursor) {
      void loadThreadMessages(threadCursor);
    }
  });
  const loadThreads = async (channel) => {
    selectedThread = null;
    threadCursor = null;
    threadLatestMessageId = null;
    threadMore.hidden = true;
    threadTranscript.replaceChildren();
    threadTranscript.hidden = true;
    threadComposer.hidden = true;
    threadStatus.textContent = "Loading threads…";
    try {
      const data = await request(`/api/v1/streams/${encodeURIComponent(channel.id)}/threads`);
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
            const workspaceId = routedWorkspaceId || localStorage.getItem("runner-team-id") || "";
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
        if (error.status === 401 || error.status === 403) {
          eventList.replaceChildren();
          eventCursor = null;
          eventResumeCursor = null;
          eventMore.hidden = true;
        }
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
    routedChannelId = channel.id;
    const target = `/ui/workspaces/${encodeURIComponent(routedWorkspaceId)}/channels/${encodeURIComponent(channel.id)}`;
    if (routedWorkspaceId && window.location.pathname !== target) {
      history.pushState(null, "", target);
      window.dispatchEvent(new PopStateEvent("popstate"));
    }
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
      const data = await request("/api/v1/streams");
      canEdit = data.canEdit !== false;
      form.hidden = !canEdit || !(data.streams || []).length;
      composer.hidden = !canEdit || !selected;
      const channels = data.streams || [];
      if (channels.length) {
        sidebar.insertBefore(form, channelsList);
      } else {
        emptyState.insertBefore(form, cancelCreate);
      }
      emptyState.hidden = channels.length > 0;
      layout.hidden = channels.length === 0;
      heading.hidden = channels.length === 0;
      title.hidden = !channels.length;
      threadsSection.hidden = !channels.length;
      eventHistory.hidden = !channels.length;
      status.hidden = false;
      transcript.hidden = !channels.length;
      more.hidden = !channels.length;
      refresh.hidden = !channels.length;
      composer.hidden = !channels.length || !canEdit;
      emptyAction.hidden = !canEdit;
      noPermission.hidden = canEdit;
      emptyAction.disabled = !canEdit;
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
        status.textContent = "";
      } else if (routedChannelId) {
        const routedChannel = channels.find((channel) => channel.id === routedChannelId);
        if (routedChannel) {
          await select(routedChannel);
          return;
        } else {
          selectionGeneration += 1;
          eventGeneration += 1;
          eventRequest = null;
          selected = null;
          selectedThread = null;
          routedChannelId = "";
          title.textContent = "Select a channel";
          transcript.replaceChildren();
          threadList.replaceChildren();
          more.hidden = true;
          refresh.hidden = true;
          composer.hidden = true;
          threadForm.hidden = true;
          eventHistory.hidden = true;
          eventList.replaceChildren();
          eventStatus.textContent = "";
          status.setAttribute("role", "alert");
          status.textContent = "This channel is unavailable in the selected workspace.";
        }
      } else if (!selected) {
        status.textContent = "Choose a channel to view its transcript.";
      }
      if (selected) {
        await select(channels.find((channel) => channel.id === selected.id) || channels[0]);
      }
    } catch (error) {
      emptyState.hidden = true;
      layout.hidden = false;
      status.textContent = error.message || "Unable to load channels.";
      status.setAttribute("role", "alert");
    }
  };
  emptyAction.addEventListener("click", () => {
    emptyAction.hidden = true;
    emptyCopy.hidden = true;
    createError.hidden = true;
    form.hidden = false;
    cancelCreate.hidden = false;
    name.focus();
  });
  cancelCreate.addEventListener("click", () => {
    form.reset();
    form.hidden = true;
    cancelCreate.hidden = true;
    createError.hidden = true;
    emptyAction.hidden = !canEdit;
    emptyCopy.hidden = false;
    emptyAction.focus();
  });
  const syncRoutedChannel = () => {
    const params = root.routeParams || {};
    if (params.page !== "channels" || params.teamId !== routedWorkspaceId) {
      return;
    }
    const nextChannelId = params.channelId || "";
    if (nextChannelId === routedChannelId) {
      return;
    }
    routedChannelId = nextChannelId;
    if (!nextChannelId) {
      selected = null;
      title.textContent = "Select a channel";
      transcript.replaceChildren();
      threadList.replaceChildren();
      return;
    }
    const button = [...channelsList.querySelectorAll("button")].find((item) => item.dataset.id === nextChannelId);
    button?.click();
  };
  window.addEventListener("runner-route-changed", syncRoutedChannel);
  form.addEventListener("submit", async (event) => {
    event.preventDefault();
    if (!canEdit || !name.reportValidity()) {
      return;
    }
    create.disabled = true;
    try {
      const data = await request("/api/v1/streams", {
        method: "POST",
        body: JSON.stringify({ name: name.value.trim() }),
      });
      window.dispatchEvent(new Event("runner-channels-updated"));
      name.value = "";
      form.hidden = true;
      await refreshChannels();
      if (data.stream) {
        await select(data.stream);
      }
    } catch (error) {
      createError.textContent = error.message || "Unable to create channel.";
      createError.hidden = false;
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
      const data = await request(`/api/v1/streams/${encodeURIComponent(channelId)}/threads`, {
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
        `/api/v1/streams/${encodeURIComponent(channelId)}/threads/${encodeURIComponent(threadId)}/messages`,
        {
          method: "POST",
          body: JSON.stringify({ body }),
        },
      );
      threadPayload.value = "";
      await loadThreadMessages(threadLatestMessageId);
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
    window.removeEventListener("runner-route-changed", syncRoutedChannel);
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
    if (routedWorkspaceId) {
      eventUrl.searchParams.set("teamId", routedWorkspaceId);
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
        void loadThreadMessages(threadLatestMessageId);
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
