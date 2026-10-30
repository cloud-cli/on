import { computed, getElement, onDestroy, onInit, ref } from "@li3/web";
import { apiFetch } from "@app/api-client.mjs";
import { formatIncomingPayload } from "./incoming-event-payload.mjs";
export { formatIncomingPayload } from "./incoming-event-payload.mjs";

export default function setup() {
  const routeParams = getElement().routeParams || {};
  const workspaceId = routeParams.workspaceId || new URLSearchParams(window.location.search).get("workspaceId") || "";
  const events = ref([]);
  const listState = ref("loading");
  const listError = ref("");
  const detailState = ref("closed");
  const detailError = ref("");
  const currentEvent = ref(null);
  const retriggering = ref(false);
  const retriggerStatus = ref("");
  let destroyed = false;
  let listController;
  let detailController;

  const runsUrl = computed(() => `/ui/workspaces/${encodeURIComponent(workspaceId)}/runs`);
  const eventRows = computed(() =>
    events.value.map((event) => ({
      ...event,
      displayType: event.eventType || "event",
      displayId: event.deliveryId || event.id,
      formattedDate: formatDate(event.receivedAt),
      formattedBytes: `${Number(event.payloadBytes || 0).toLocaleString()} bytes`,
      statusClass: Object.hasOwn(statusClasses, event.processingStatus)
        ? statusClasses[event.processingStatus]
        : statusClasses.received,
      inspectLabel: `Inspect ${event.provider} ${event.eventType || "event"}`,
    })),
  );
  const detailSummary = computed(() => {
    const event = currentEvent.value;
    return event
      ? `${event.eventType || "unknown event"} · ${event.deliveryId || event.id} · ${formatDate(event.receivedAt)}`
      : "";
  });
  const detailTitle = computed(() => (currentEvent.value ? `${currentEvent.value.provider} event` : "Event details"));
  const displayPayload = computed(() => formatIncomingPayload(currentEvent.value));
  const canRetrigger = computed(() => currentEvent.value?.validationStatus === "valid");
  const validationMessage = computed(() =>
    canRetrigger.value ? "Only this verified delivery will be replayed." : "Unverified payloads cannot be replayed.",
  );

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

  const loadEvents = async () => {
    listController?.abort();
    const controller = new AbortController();
    listController = controller;
    listState.value = "loading";
    listError.value = "";
    try {
      const { events: result = [] } = await request(
        `/api/v1/workspaces/${encodeURIComponent(workspaceId)}/events?limit=100`,
        { signal: controller.signal },
      );
      if (!destroyed && listController === controller) {
        events.value = result.map((event) => ({
          ...event,
          formattedDate: formatDate(event.receivedAt),
        }));
        listState.value = result.length ? "ready" : "empty";
      }
    } catch (error) {
      if (!destroyed && listController === controller && error.name !== "AbortError") {
        listError.value = error.message || "Unable to load incoming events";
        listState.value = "error";
      }
    }
  };

  const openDetail = async (eventId) => {
    detailController?.abort();
    const controller = new AbortController();
    detailController = controller;
    detailState.value = "loading";
    detailError.value = "";
    currentEvent.value = null;
    retriggerStatus.value = "";
    try {
      const { event } = await request(
        `/api/v1/workspaces/${encodeURIComponent(workspaceId)}/events/${encodeURIComponent(eventId)}`,
        { signal: controller.signal },
      );
      if (!destroyed && detailController === controller) {
        currentEvent.value = event;
        detailState.value = "ready";
      }
    } catch (error) {
      if (!destroyed && detailController === controller && error.name !== "AbortError") {
        detailError.value = error.message || "Unable to load event details";
        detailState.value = "error";
      }
    }
  };

  const closeDetail = () => {
    detailController?.abort();
    detailController = undefined;
    detailState.value = "closed";
    currentEvent.value = null;
  };

  const retrigger = async () => {
    const event = currentEvent.value;
    if (!event || event.validationStatus !== "valid" || retriggering.value) {
      return;
    }
    retriggering.value = true;
    retriggerStatus.value = "Matching this event against current published workflows…";
    try {
      const result = await request(
        `/api/v1/workspaces/${encodeURIComponent(workspaceId)}/events/${encodeURIComponent(event.id)}/retrigger`,
        { method: "POST" },
      );
      if (destroyed) {
        return;
      }
      retriggerStatus.value = result.queuedJobs
        ? `Queued ${result.queuedJobs} job${result.queuedJobs === 1 ? "" : "s"}: ${(result.jobs || []).join(", ")}`
        : "No current published workflow matched this event. The replay was recorded.";
      await loadEvents();
    } catch (error) {
      if (!destroyed) {
        retriggerStatus.value = error.message || "Could not retrigger this event";
      }
    } finally {
      if (!destroyed) {
        retriggering.value = false;
      }
    }
  };

  onInit(() => void loadEvents());
  onDestroy(() => {
    destroyed = true;
    listController?.abort();
    detailController?.abort();
  });

  return {
    events: eventRows,
    listState,
    listError,
    detailState,
    detailError,
    currentEvent,
    detailTitle,
    detailSummary,
    displayPayload,
    canRetrigger,
    validationMessage,
    retriggering,
    retriggerStatus,
    runsUrl,
    loadEvents,
    openDetail,
    closeDetail,
    retrigger,
  };
}

const statusClasses = {
  queued: "border-emerald-200 bg-emerald-50 text-emerald-800",
  unmatched: "border-amber-200 bg-amber-50 text-amber-900",
  rejected: "border-rose-200 bg-rose-50 text-rose-800",
  failed: "border-rose-200 bg-rose-50 text-rose-800",
  received: "border-slate-200 bg-slate-50 text-slate-700",
};

function formatDate(value) {
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? value : date.toLocaleString();
}
