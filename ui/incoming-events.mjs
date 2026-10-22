import { onDestroy, onInit, ref } from "@li3/web";
import { apiFetch } from "@app/api-client.mjs";

export default function setup() {
  const root = document.querySelector("[data-incoming-events-root]");
  if (!root) {
    return;
  }

  const workspaceId = decodeURIComponent(
    window.location.pathname.match(/^\/workspaces\/([^/]+)\/runs\/events$/)?.[1] || "",
  );
  const list = root.querySelector("[data-list]");
  const loading = root.querySelector("[data-loading]");
  const listError = root.querySelector("[data-list-error]");
  const detail = root.querySelector("[data-detail]");
  const payload = root.querySelector("[data-payload]");
  const retriggerButton = root.querySelector("[data-retrigger]");
  const retriggerStatus = root.querySelector("[data-retrigger-status]");
  const selectedEventId = ref("");
  const currentEvent = ref(null);
  const runsLink = root.querySelector("[data-runs-link]");
  runsLink.href = `/ui/workspaces/${encodeURIComponent(workspaceId)}/runs`;

  const request = async (url, options = {}) => {
    const response = await apiFetch(url, {
      credentials: "same-origin",
      ...options,
      headers: { accept: "application/json", ...(options.headers || {}) },
    });
    const data = await response.json().catch(() => ({}));
    if (!response.ok) {
      throw new Error(data.error || `Request failed (${response.status})`);
    }
    return data;
  };

  const formatDate = (value) => {
    const date = new Date(value);
    return Number.isNaN(date.getTime()) ? value : date.toLocaleString();
  };

  const badge = (status) => {
    const element = document.createElement("span");
    const colors = {
      queued: "border-emerald-200 bg-emerald-50 text-emerald-800",
      unmatched: "border-amber-200 bg-amber-50 text-amber-900",
      rejected: "border-rose-200 bg-rose-50 text-rose-800",
      failed: "border-rose-200 bg-rose-50 text-rose-800",
      received: "border-slate-200 bg-slate-50 text-slate-700",
    };
    element.className = `inline-flex rounded-full border px-2.5 py-1 text-xs font-semibold ${colors[status] || colors.received}`;
    element.textContent = status;
    return element;
  };

  const openDetail = async (eventId) => {
    try {
      const { event } = await request(
        `/api/v1/workspaces/${encodeURIComponent(workspaceId)}/events/${encodeURIComponent(eventId)}`,
      );
      currentEvent.value = event;
      selectedEventId.value = event.id;
      root.querySelector("[data-detail-title]").textContent = `${event.provider} event`;
      root.querySelector("[data-detail-summary]").textContent =
        `${event.eventType || "unknown event"} · ${event.deliveryId || event.id} · ${formatDate(event.receivedAt)}`;
      let displayPayload = event.payload;
      try {
        displayPayload = JSON.stringify(JSON.parse(event.payload), null, 2);
      } catch {
        // Keep non-JSON body bytes readable as UTF-8 text.
      }
      payload.textContent = displayPayload;
      retriggerButton.disabled = event.validationStatus !== "valid";
      retriggerStatus.textContent =
        event.validationStatus === "valid"
          ? "Only this verified delivery will be replayed."
          : "Unverified payloads cannot be replayed.";
      detail.classList.remove("hidden");
      detail.scrollIntoView({ behavior: "smooth", block: "start" });
    } catch (error) {
      listError.textContent = error.message || "Unable to load event details";
      listError.classList.remove("hidden");
    }
  };

  const renderEvents = (events) => {
    list.replaceChildren();
    if (!events.length) {
      const empty = document.createElement("p");
      empty.className = "p-8 text-center text-sm text-app-secondary";
      empty.textContent = "No incoming events have been recorded for this workspace yet.";
      list.append(empty);
      return;
    }
    const table = document.createElement("table");
    table.className = "w-full min-w-[700px] text-left text-sm";
    table.innerHTML = `<thead class="border-b border-app-border text-xs text-app-secondary"><tr><th class="px-4 py-3 font-medium">Event</th><th class="px-4 py-3 font-medium">Status</th><th class="px-4 py-3 font-medium">Received</th><th class="px-4 py-3 font-medium">Payload</th><th class="px-4 py-3 font-medium">Actions</th></tr></thead>`;
    const body = document.createElement("tbody");
    for (const event of events) {
      const row = document.createElement("tr");
      row.className = "border-b border-app-border last:border-0";
      const title = document.createElement("td");
      title.className = "px-4 py-3";
      const type = document.createElement("p");
      type.className = "font-medium";
      type.textContent = `${event.provider} · ${event.eventType || "event"}`;
      const id = document.createElement("p");
      id.className = "mt-1 break-all font-mono text-xs text-app-secondary";
      id.textContent = event.deliveryId || event.id;
      title.append(type, id);
      const status = document.createElement("td");
      status.className = "px-4 py-3";
      status.append(badge(event.processingStatus));
      const received = document.createElement("td");
      received.className = "px-4 py-3 text-app-secondary";
      received.textContent = formatDate(event.receivedAt);
      const size = document.createElement("td");
      size.className = "px-4 py-3 text-app-secondary";
      size.textContent = `${event.payloadBytes.toLocaleString()} bytes`;
      const actions = document.createElement("td");
      actions.className = "px-4 py-3";
      const view = document.createElement("button");
      view.type = "button";
      view.className =
        "font-semibold text-app-primary underline-offset-2 hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-app-primary";
      view.textContent = "Inspect";
      view.setAttribute("aria-label", `Inspect ${event.provider} ${event.eventType || "event"}`);
      view.addEventListener("click", () => void openDetail(event.id));
      actions.append(view);
      row.append(title, status, received, size, actions);
      body.append(row);
    }
    table.append(body);
    const region = document.createElement("div");
    region.className = "overflow-x-auto";
    region.append(table);
    list.append(region);
  };

  const loadEvents = async () => {
    loading.classList.remove("hidden");
    listError.classList.add("hidden");
    try {
      const { events = [] } = await request(`/api/v1/workspaces/${encodeURIComponent(workspaceId)}/events?limit=100`);
      renderEvents(events);
    } catch (error) {
      listError.textContent = error.message || "Unable to load incoming events";
      listError.classList.remove("hidden");
      list.replaceChildren();
    } finally {
      loading.classList.add("hidden");
    }
  };

  const retrigger = async () => {
    if (!selectedEventId.value || !currentEvent.value || retriggerButton.disabled) {
      return;
    }
    retriggerButton.disabled = true;
    retriggerStatus.textContent = "Matching this event against current published workflows…";
    try {
      const result = await request(
        `/api/v1/workspaces/${encodeURIComponent(workspaceId)}/events/${encodeURIComponent(selectedEventId.value)}/retrigger`,
        { method: "POST" },
      );
      retriggerStatus.textContent = result.queuedJobs
        ? `Queued ${result.queuedJobs} job${result.queuedJobs === 1 ? "" : "s"}: ${result.jobs.join(", ")}`
        : "No current published workflow matched this event. The replay was recorded.";
      await loadEvents();
    } catch (error) {
      retriggerStatus.textContent = error.message || "Could not retrigger this event";
    } finally {
      retriggerButton.disabled = false;
    }
  };

  retriggerButton.addEventListener("click", retrigger);
  onInit(() => void loadEvents());
  onDestroy(() => retriggerButton.removeEventListener("click", retrigger));
}
