import { describe, expect, it } from "vitest";
import source from "./invocation-ui.mjs?raw";

describe("invocation UI", () => {
  it("keeps invocation admission separate from canonical run status and workspace context", () => {
    expect(source).toContain("/api/v1/workflow-invocations/${encodeURIComponent(invocationId)}");
    expect(source).toContain("Admission: ${variant.admissionStatus}");
    expect(source).toContain("Decision: ${variant.admissionOutcome}");
    expect(source).toContain("/api/v1/runs/${encodeURIComponent(runId)}");
    expect(source).toContain("jobs.changed");
    expect(source).toContain('eventsUrl.searchParams.set("teamId", workspaceId)');
    expect(source).toContain("routeParams = root.routeParams || {}");
    expect(source).toContain("runStatusRefreshers");
  });

  it("closes workspace event listeners when the invocation view is removed", () => {
    expect(source).toContain("eventSource?.close()");
    expect(source).toContain("if (!root.isConnected)");
  });
});
