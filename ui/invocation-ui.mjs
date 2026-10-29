import { apiFetch } from "@app/api-client.mjs";

const node = (tag, text, className) => {
  const item = document.createElement(tag);
  if (text !== undefined) {
    item.textContent = text;
  }
  if (className) {
    item.className = className;
  }
  return item;
};

export function mountInvocation(root, routeParams = root.routeParams || {}) {
  const workspaceId = routeParams.workspaceId || root.dataset.workspaceId;
  const invocationId = routeParams.invocationId || root.dataset.invocationId;
  root.className = "mx-auto w-full max-w-4xl space-y-5 py-6";
  const back = node("a", "Back to workspace", "text-sm underline");
  back.href = `/ui/workspaces/${encodeURIComponent(workspaceId)}/channels`;
  const heading = node("h1", "Workflow invocation", "text-2xl font-semibold");
  const status = node("p", "Loading invocation…", "text-sm text-app-secondary");
  status.setAttribute("role", "status");
  const summary = node(
    "dl",
    undefined,
    "grid gap-2 rounded-xl border border-app-border bg-app-card p-4 sm:grid-cols-[10rem_1fr]",
  );
  const variants = node("ol", undefined, "space-y-3");
  const runStatusRefreshers = new Map();
  let eventSource = null;
  let removalObserver = null;
  variants.setAttribute("aria-label", "Invocation variants and runs");
  root.replaceChildren(back, heading, status, summary, variants);

  const load = async () => {
    const headers = { accept: "application/json", "X-Workspace-ID": workspaceId };
    try {
      const response = await apiFetch(`/api/v1/workflow-invocations/${encodeURIComponent(invocationId)}`, { headers });
      const data = await response.json().catch(() => ({}));
      if (!response.ok) {
        throw new Error(data.error || `Unable to load invocation (${response.status})`);
      }
      if (!root.isConnected) {
        return;
      }
      const fields = [
        ["Invocation ID", data.id],
        ["Request event", data.requestEventId],
        ["Workflow", `${data.workflowId} @ revision ${data.revision}`],
        ["Requested", data.recordedAt],
      ];
      summary.replaceChildren(
        ...fields.flatMap(([label, value]) => [
          node("dt", label, "text-sm font-semibold"),
          node("dd", String(value || "—"), "min-w-0 break-all text-sm"),
        ]),
      );
      variants.replaceChildren(
        ...(data.variants || []).map((variant) => {
          const item = node("li", undefined, "space-y-2 rounded-xl border border-app-border bg-app-card p-4");
          item.append(node("h2", `Variant ${variant.variantIndex}`, "font-semibold"));
          item.append(node("p", `Admission: ${variant.admissionStatus}`, "text-sm"));
          if (variant.admissionOutcome) {
            item.append(node("p", `Decision: ${variant.admissionOutcome}`, "text-sm"));
          }
          if (variant.errorCode) {
            item.append(node("p", `Admission error: ${variant.errorCode}`, "text-sm text-rose-700"));
          }
          if (variant.runId) {
            const run = node("a", `Run ${variant.runId}`, "text-sm underline");
            run.href = `/ui/runs/${encodeURIComponent(variant.runId)}?workspaceId=${encodeURIComponent(workspaceId)}`;
            item.append(run);
            const runStatus = node("p", "Current run status: loading…", "text-sm text-app-secondary");
            runStatus.setAttribute("aria-live", "polite");
            item.append(runStatus);
            const refresh = () => loadRunStatus(variant.runId, runStatus, workspaceId);
            runStatusRefreshers.set(String(variant.runId), refresh);
            void refresh();
          }
          return item;
        }),
      );
      if (!data.variants?.length) {
        variants.append(
          node(
            "li",
            "No execution variants have been admitted yet.",
            "rounded-xl border border-app-border p-4 text-sm",
          ),
        );
      }
      status.textContent = "Invocation and execution state loaded.";
    } catch (error) {
      status.setAttribute("role", "alert");
      status.textContent = error.message || "Unable to load invocation.";
    }
  };

  const loadRunStatus = async (runId, target, workspaceId) => {
    const requestVersion = requestVersionFor(target);
    try {
      const response = await apiFetch(`/api/v1/runs/${encodeURIComponent(runId)}`, {
        headers: { accept: "application/json", "X-Workspace-ID": workspaceId },
      });
      const report = await response.json().catch(() => ({}));
      if (!response.ok) {
        throw new Error(report.error || `Unable to load run status (${response.status})`);
      }
      if (root.isConnected && Number(target.dataset.requestVersion) === requestVersion) {
        target.textContent = `Current run status: ${report.status || "unknown"}`;
      }
    } catch (error) {
      if (root.isConnected && Number(target.dataset.requestVersion) === requestVersion) {
        target.textContent = error.message || "Current run status unavailable.";
      }
    }
  };
  const requestVersionFor = (target) => {
    const version = Number(target.dataset.requestVersion || 0) + 1;
    target.dataset.requestVersion = String(version);
    return version;
  };
  const refreshRunStatuses = () => {
    for (const refresh of runStatusRefreshers.values()) {
      void refresh();
    }
  };
  if (typeof EventSource !== "undefined") {
    const eventsUrl = new URL("/api/events", window.location.href);
    eventsUrl.searchParams.set("teamId", workspaceId);
    eventSource = new EventSource(eventsUrl);
    eventSource.addEventListener("jobs.changed", (event) => {
      let notification;
      try {
        notification = JSON.parse(event.data);
      } catch {
        return;
      }
      if (notification.teamId === workspaceId) {
        refreshRunStatuses();
      }
    });
    eventSource.addEventListener("open", refreshRunStatuses);
  }
  if (typeof MutationObserver !== "undefined" && document.documentElement) {
    removalObserver = new MutationObserver(() => {
      if (root.isConnected) {
        return;
      }
      eventSource?.close();
      removalObserver?.disconnect();
    });
    removalObserver.observe(document.documentElement, { childList: true, subtree: true });
  }
  void load();
}
