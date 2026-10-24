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
  const heading = element("h1", "Channels", "text-2xl font-semibold");
  heading.id = "channels-title";
  const layout = element(
    "div",
    undefined,
    "grid gap-5 md:grid-cols-[minmax(14rem,0.35fr)_minmax(0,1fr)]",
  );
  const sidebar = element(
    "section",
    undefined,
    "min-w-0 space-y-3 rounded-xl border border-app-border bg-app-card p-4",
  );
  sidebar.setAttribute("aria-label", "Channels");
  const form = document.createElement("form");
  form.className = "flex gap-2";
  const name = document.createElement("input");
  name.name = "name";
  name.maxLength = 120;
  name.required = true;
  name.placeholder = "New channel";
  name.setAttribute("aria-label", "New channel name");
  name.className =
    "min-w-0 flex-1 rounded-lg border border-app-border px-3 py-2";
  const create = element(
    "button",
    "Create",
    "rounded-lg bg-app-primary px-3 py-2 text-sm font-semibold text-white",
  );
  form.append(name, create);
  const channelsList = element("ul", undefined, "space-y-1");
  channelsList.setAttribute("aria-label", "Available channels");
  sidebar.append(form, channelsList);
  const conversation = element(
    "section",
    undefined,
    "min-w-0 space-y-4 rounded-xl border border-app-border bg-app-card p-4",
  );
  conversation.setAttribute("aria-label", "Channel transcript");
  const title = element(
    "h2",
    "Select a channel",
    "min-w-0 break-all text-lg font-semibold",
  );
  const status = element(
    "p",
    "Loading channels…",
    "text-sm text-app-secondary",
  );
  status.setAttribute("role", "status");
  status.setAttribute("aria-live", "polite");
  const transcript = element(
    "ol",
    undefined,
    "max-h-[55vh] space-y-3 overflow-auto",
  );
  transcript.setAttribute("aria-label", "Messages");
  transcript.tabIndex = 0;
  const more = element(
    "button",
    "Load newer messages",
    "rounded-lg border border-app-border px-3 py-2 text-sm",
  );
  more.type = "button";
  more.hidden = true;
  const refresh = element(
    "button",
    "Check for new messages",
    "rounded-lg border border-app-border px-3 py-2 text-sm",
  );
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
  payload.className =
    "w-full rounded-lg border border-app-border p-3 font-mono text-sm";
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
  conversation.append(title, status, transcript, more, refresh, composer);
  layout.append(sidebar, conversation);
  root.replaceChildren(heading, layout);

  let selected = null;
  let cursor = null;
  let latestMessageId = null;
  let selectionGeneration = 0;
  let activeMessageRequest = null;
  let canEdit = false;
  let disposed = false;
  let pollTimer = null;
  let channelEvents = null;
  let removalObserver = null;
  const request = async (url, options) => {
    const { headers: requestHeaders, ...requestOptions } = options || {};
    const response = await apiFetch(url, {
      ...requestOptions,
      headers: {
        accept: "application/json",
        "content-type": "application/json",
        ...(root.dataset.workspaceId
          ? { "X-Team-ID": root.dataset.workspaceId }
          : {}),
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
      ? new Set(
          [...transcript.querySelectorAll("[data-message-id]")].map(
            (node) => node.dataset.messageId,
          ),
        )
      : new Set();
    const items = messages
      .filter((message) => !existing.has(message.id))
      .map((message) => {
        const item = element(
          "li",
          undefined,
          "min-w-0 rounded-lg bg-app-panel p-3",
        );
        item.dataset.messageId = message.id;
        const metadata = element(
          "p",
          `${message.author || "Member"} · ${message.createdAt || ""}`,
          "text-xs text-app-secondary",
        );
        item.append(metadata);
        const body = element(
          "pre",
          typeof message.body === "string"
            ? message.body
            : JSON.stringify(message.body, null, 2),
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
      const data = await request(
        `/api/v1/channels/${encodeURIComponent(channelId)}/messages?${query}`,
      );
      if (generation !== selectionGeneration || selected?.id !== channelId) {
        return;
      }
      drawMessages(data.messages || [], Boolean(after));
      cursor = data.next || null;
      if (data.messages?.length) {
        const renderedMessages =
          transcript.querySelectorAll("[data-message-id]");
        latestMessageId =
          renderedMessages[renderedMessages.length - 1]?.dataset.messageId ||
          latestMessageId;
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
  const select = async (channel) => {
    selectionGeneration += 1;
    selected = channel;
    cursor = null;
    latestMessageId = null;
    transcript.replaceChildren();
    more.hidden = true;
    refresh.hidden = true;
    title.textContent = channel.name;
    composer.hidden = !canEdit;
    for (const button of channelsList.querySelectorAll("button")) {
      button.setAttribute(
        "aria-pressed",
        String(button.dataset.id === channel.id),
      );
      button.classList.toggle("bg-slate-100", button.dataset.id === channel.id);
      button.classList.toggle(
        "font-semibold",
        button.dataset.id === channel.id,
      );
    }
    await loadMessages();
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
        const data = await request(
          `/api/v1/channels/${encodeURIComponent(channelId)}/messages?${query}`,
        );
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
          button.setAttribute(
            "aria-pressed",
            String(selected?.id === channel.id),
          );
          if (selected?.id === channel.id) {
            button.classList.add("bg-slate-100", "font-semibold");
          }
          button.addEventListener("click", () => void select(channel));
          li.append(button);
          return li;
        }),
      );
      if (!channels.length) {
        status.textContent =
          "No channels yet. Create one to start a conversation.";
      } else if (!selected) {
        status.textContent = "Choose a channel to view its transcript.";
      }
      if (selected) {
        await select(
          channels.find((channel) => channel.id === selected.id) || channels[0],
        );
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
  more.addEventListener("click", () => void loadMessages(cursor));
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
      const data = await request(
        `/api/v1/channels/${encodeURIComponent(channelId)}/messages`,
        {
          method: "POST",
          body: JSON.stringify({ body }),
        },
      );
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
    channelEvents.addEventListener("open", () => {
      // Reconcile after initial connect and every automatic reconnect to recover gaps.
      if (!disposed && selected) {
        void refreshMessages();
      }
    });
  }
  pollTimer = setTimeout(pollForMessages, 15_000);
}
