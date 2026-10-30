import { describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { buildRunView, formatInputsDisplayJson, renderRunHtml, type RunView } from "../ui/run-view.js";
import type { WorkflowExecutionReport } from "./types.js";
import runSetup from "../ui/run.mjs?raw";

function report(status: WorkflowExecutionReport["status"]): WorkflowExecutionReport {
  return {
    jobId: "42",
    parentId: "",
    workflowName: "deploy",
    status,
    durationMs: 250,
    startedAt: "2026-09-04T00:00:00.000Z",
    inputs: { branch: "main" },
    environment: { SECRET_TOKEN: "hidden" },
    steps: [
      {
        id: "build",
        name: "Build",
        status: "success",
        durationMs: 100,
        exitCode: 0,
        outputs: { artifact: "app.tar" },
        logContent: "",
      },
      {
        id: "deploy",
        name: "Deploy",
        status: "running",
        durationMs: 0,
        outputs: {},
        logContent: "",
      },
    ],
    artifacts: [],
    rerunToken: '{"secret":"hidden"}',
  };
}

function view(status: RunView["status"]): RunView {
  return {
    jobId: "42",
    parentId: "",
    workflowName: "deploy",
    status,
    durationMs: 250,
    startedAt: "2026-09-04T00:00:00.000Z",
    inputs: { branch: "main" },
    steps: report(status).steps,
    artifacts: [],
    canViewLogs: true,
  };
}

describe("run view", () => {
  it("formats JSON inputs normally and represents Buffer JSON as bounded hex", () => {
    expect(formatInputsDisplayJson({ branch: "main", options: { shallow: true } })).toBe(
      '{\n  "branch": "main",\n  "options": {\n    "shallow": true\n  }\n}',
    );
    const displayed = formatInputsDisplayJson({ binary: { type: "Buffer", data: [0, 15, 255] } });
    expect(displayed).toContain("Binary payload: 3 bytes; hex: 00 0f ff");

    const long = formatInputsDisplayJson({ binary: { type: "Buffer", data: Array(257).fill(171) } });
    expect(long).toContain("Binary payload: 257 bytes; hex (first 256 bytes)");
    expect(long.match(/ab/g)).toHaveLength(256);
  });

  it("removes private report fields and redacts exposed values", () => {
    const storedReport = report("success");
    storedReport.inputs = {
      branch: "main",
      raw: { installation: "private" },
      accessToken: "private",
      access_key: "private",
      passphrase: "private",
      message: "contains top-secret",
    };
    const runView = buildRunView(
      {
        id: 42,
        workflow_id: "deploy",
        status: "success",
        payload: JSON.stringify({ workflowId: "deploy", inputs: {}, steps: [] }),
        report: JSON.stringify(storedReport),
      } as any,
      { build: "using top-secret" },
      (value) => value.replaceAll("top-secret", "****"),
    );

    expect(runView.inputs).toEqual({
      branch: "main",
      raw: { installation: "private" },
      message: "contains ****",
    });
    expect(runView.steps[0].logContent).toBe("using ****");
    expect(runView).not.toHaveProperty("environment");
    expect(runView).not.toHaveProperty("rerunToken");
  });

  it("accepts a queue-decrypted payload object when building a pending run view", () => {
    const pending = buildRunView(
      {
        id: 43,
        workflow_id: "deploy",
        status: "pending",
        payload: { inputs: { branch: "secure-branch" } },
        report: null,
        created_at: "2026-09-04T00:00:00.000Z",
      } as any,
      {},
      (value) => value,
      [],
      true,
      undefined,
      undefined,
      { inputs: true },
    );

    expect(pending.inputs).toEqual({ branch: "secure-branch" });
  });

  it("does not read inherited properties as step logs", () => {
    const storedReport = report("success");
    storedReport.steps[0].id = "toString";
    const runView = buildRunView(
      {
        id: 42,
        workflow_id: "deploy",
        status: "success",
        payload: JSON.stringify({ workflowId: "deploy", inputs: {}, steps: [] }),
        report: JSON.stringify(storedReport),
      } as any,
      {},
      (value) => value,
    );

    expect(runView.steps[0].logContent).toBe("");
  });

  it("projects nested call records with separate input and output permissions", () => {
    const storedReport = report("success");
    storedReport.callInstances = [
      {
        callId: "42:deploy-call#attempt-1",
        callSiteId: "deploy-call",
        target: "team/build@2#main",
        functionName: "main",
        status: "success",
        stepIds: ["deploy-call#attempt-1/compile"],
        inputs: { message: "contains top-secret", password: "top-secret" },
        outputs: { artifact: "bundle.tar", token: "top-secret" },
        durationMs: 10,
      },
    ];
    const source = {
      id: 42,
      workflow_id: "deploy",
      status: "success",
      payload: JSON.stringify({ workflowId: "deploy", inputs: {}, steps: [] }),
      report: JSON.stringify(storedReport),
    } as any;
    const redact = (value: string) => value.replaceAll("top-secret", "****");
    const inputOnly = buildRunView(source, {}, redact, [], false, undefined, undefined, { inputs: true, logs: false });
    expect(inputOnly.callInstances?.[0]).toMatchObject({
      callId: "42:deploy-call#attempt-1",
      target: "team/build@2#main",
      inputs: { message: "contains ****" },
      outputs: {},
    });

    const logsOnly = buildRunView(source, {}, redact, [], true, undefined, undefined, { inputs: false, logs: true });
    expect(logsOnly.callInstances?.[0]).toMatchObject({
      inputs: undefined,
      outputs: { artifact: "bundle.tar" },
    });
    expect(JSON.stringify(logsOnly.callInstances)).not.toContain("top-secret");
  });

  it("omits logs from unauthenticated views", () => {
    const storedReport = report("success");
    storedReport.steps[0].logContent = "private report log";
    const runView = buildRunView(
      {
        id: 42,
        workflow_id: "deploy",
        status: "success",
        payload: JSON.stringify({ workflowId: "deploy", inputs: {}, steps: [] }),
        report: JSON.stringify(storedReport),
      } as any,
      { build: "private step log" },
      (value) => value,
      [],
      false,
    );

    expect(runView.canViewLogs).toBe(false);
    expect(runView.steps[0].name).toBe("Build");
    expect(runView.steps[0].logContent).toBe("");
  });

  it("uses the workflow YAML name for a pending run instead of its internal ID", () => {
    const runView = buildRunView(
      {
        id: 42,
        workflow_id: "e4fbf26d-778d-4ea4-a9bd-657b0f526737",
        status: "pending",
        payload: JSON.stringify({ workflowId: "e4fbf26d-778d-4ea4-a9bd-657b0f526737", inputs: {}, steps: [] }),
        report: null,
        created_at: "2026-09-04T00:00:00.000Z",
      } as any,
      {},
      (value) => value,
      [],
      true,
      undefined,
      "Build/publish Docker",
    );

    expect(runView.workflowName).toBe("Build/publish Docker");
    expect(runView.workflowName).not.toContain("e4fbf26d");
  });

  it("treats timezone-naive database timestamps as UTC when calculating active duration", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-09-04T12:00:00.000Z"));
    try {
      const runView = buildRunView(
        {
          id: 42,
          workflow_id: "deploy",
          status: "running",
          payload: JSON.stringify({ workflowId: "deploy", inputs: {}, steps: [] }),
          report: null,
          started_at: "2026-09-04 06:30:00",
          created_at: "2026-09-04 06:30:00",
        } as any,
        {},
        (value) => value,
      );

      expect(runView.startedAt).toBe("2026-09-04T06:30:00Z");
      expect(runView.durationMs).toBe(5.5 * 60 * 60 * 1000);
    } finally {
      vi.useRealTimers();
    }
  });

  it("injects escaped state and SSE refresh behavior into HTML", () => {
    const unsafe = view("running");
    unsafe.steps[0].logContent = "</script><script>alert(1)</script>";
    const html = renderRunHtml(unsafe);
    const source = html + runSetup;
    expect(source).not.toContain("<script state>");
    expect(source).toContain("{{ report.workflowName }}");
    expect(runSetup).toContain("now.value - parseTimestamp(report.value.startedAt)");
    expect(runSetup).toContain("return Date.parse(hasTimezone ? normalized : `${normalized}Z`)");
    expect(source).toContain('aria-label="Run metadata"');
    expect(source).toContain('<link rel="stylesheet" href="/assets/on.css" />');
    expect(source).not.toContain('bind-title="report.workflowName"');
    expect(source).toContain('href="/ui/runs"');
    expect(source).toContain('class="run-heading');
    expect(source).toContain('class="detail-meta');
    expect(source).toContain('class="execution');
    expect(source).toContain("bg-app-background");
    expect(source).toContain("bg-[#1c211e]");
    expect(source).toContain("{{ failedStepMessage }}");
    expect(source).not.toContain("{{ runOrigin }}");
    expect(source).not.toContain("Workflow execution");
    expect(source).toContain('class="flex flex-wrap items-center gap-x-2');
    expect(source).toContain('on-click="selectStep(step.index)"');
    expect(source).toContain('class="block min-w-0 flex-1 truncate"');
    expect(source).toContain('class-hidden="!report.canViewLogs"');
    expect(source).toContain("attr-href=\"'/ui/workflows/' + report.workflowId\"");
    expect(source).toContain("canEditWorkflow");
    expect(source).toContain('class-hidden="!report.canEditWorkflow"');
    expect(source).toContain("attr-aria-pressed=\"step.isSelected ? 'true' : 'false'\"");
    expect(source).toContain("attr-aria-label=\"(step.name || step.id || 'Step') + ', ' + upper(step.status)\"");
    expect(source).toContain('bind-innerhtml="stepLog(selectedStepReport)"');
    expect(source).not.toContain("state.step");
    expect(source).not.toContain("(step, index) of report.steps");
    expect(source).toContain("Logs & steps");
    expect(source).toContain("Search this step's logs");
    expect(source).toContain("toggleLogWrap()");
    expect(source).toContain('on-click="downloadLogs()"');
    expect(source).toContain('on-click="copyRunUrl()"');
    expect(runSetup).toContain("navigator.clipboard.writeText(window.location.href)");
    expect(runSetup).toContain("link.download = `run-${report.value.jobId}-logs.txt`");
    expect(runSetup).toContain('if (previousStatus !== "failed" && nextReport.status === "failed")');
    expect(source).toContain('aria-label="Copy logs"');
    expect(source).toContain("detailTab !== 'inputs'");
    expect(source).toContain("detailTab !== 'artifacts'");
    expect(source).toContain("detailTab !== 'history'");
    expect(source).toContain("aria-[selected=true]:bg-app-green-bg");
    expect(source).toContain("aria-[pressed=true]:shadow-[0_0_0_1px_#387045,0_1px_3px_#23351214]");
    expect(source).toContain("hover:bg-app-panel hover:text-app-primary");
    expect(source).toContain("data-restart-menu");
    expect(source).toContain('addEventListener("pointerdown", handleOutsideRestartMenu)');
    expect(source).toContain('removeEventListener("pointerdown", handleOutsideRestartMenu)');
    expect(source).toContain("text-[13px]");
    expect(source).toContain("'text-wrap' : 'text'");
    expect(source).toContain("formatDuration(report.value.durationMs)");
    expect(runSetup.indexOf("const formatDuration")).toBeLessThan(runSetup.indexOf("const timing = computed"));
    expect(source).toContain("isSelected: Number(selectedStep.value) === Number(index)");
    expect(source).toContain("isActive: detailTab.value === tab.id");
    expect(source).toContain('icon: "list-clock"');
    expect(source).toContain('icon="calendar-days"');
    expect(source).toContain('icon="timer"');
    expect(source).toContain('icon="server"');
    expect(source).not.toContain("{{ successfulSteps.length }}");
    expect(source).toContain('aria-label="Run details"');
    expect(source).toContain('class="failure-banner');
    expect(source).toContain("failedStepMessage");
    expect(source).toContain("Awaiting worker");
    expect(source).toContain("#{{ report.jobId }}");
    expect(source).toContain("apiFetch(`/api/v1/runs/${jobId}`");
    expect(source).toContain("lucide-icon");
    expect(source).toContain("detailTab !== 'source'");
    expect(source).toContain('theme="googlecode"');
    expect(source).not.toContain("border-t border-gray-800 bg-gray-950");
    expect(source).not.toContain("border-b border-app-border pb-4");
    expect(source).toContain('bind-source="report.workflowSourceYaml"');
    expect(source).toContain("Get AI help for failed step");
    expect(source).toContain("/ai-help");
    expect(source).toContain("Previous runs");
    expect(source).toContain("body: JSON.stringify({ inputs: report.value.inputs || {} })");
    expect(source).toContain("Original inputs");
    expect(source).toContain("setManualKey(entry, $event)");
    expect(source).toContain("report.value.parentId");
    expect(source).toContain("/api/v1/runs/${parentId}");
    expect(source).toContain("Artifacts");
    expect(source).toContain("Thinking through the failed step");
    expect(source).toContain("marked.parse(content)");
    expect(source).toContain("downloadArtifact($event, artifact)");
    expect(source).toContain("https://sodium.static.apphor.de/code-block.html");
    expect(source).toContain('bind-source="report.inputsDisplayJson || inputsJson"');
    expect(source).toContain("'circle-check'");
    expect(source).toContain("{{ report.workerName || report.workerId || 'Awaiting worker' }}");
    expect(source).toContain("formatTimestampedLogLine");
    expect(source).toContain("formatDate(report.startedAt)");
    expect(source).toContain("loadTimezonePreference()");
    expect(source).not.toContain("https://cdn.tailwindcss.com");
    expect(source).toContain("new EventSource(");
    expect(source).toContain("/api/v1/events?teamId=");
    expect(source).toContain('addEventListener("jobs.changed", handleJobChange)');
    expect(source).toContain("apiFetch(`/api/v1/runs/${jobId}`");
    expect(source).toContain("now.value = Date.now()");
    expect(source).toContain('href="/assets/manifest.webmanifest"');
    expect(source).toContain('navigator.serviceWorker.register("/assets/service-worker.js", { scope: "/ui/" })');
    expect(source).toContain("registration.showNotification(");
    expect(source).not.toContain("location.reload()");
    expect(source).not.toContain("</script><script>alert(1)</script>");
    expect(source).not.toContain("unsafe");
  });

  it("gives the selected tab and step a clear active treatment", () => {
    const html = readFileSync(resolve(process.cwd(), "ui/run.html"), "utf8");
    const css = readFileSync(resolve(process.cwd(), "ui/index.css"), "utf8");

    expect(html).toContain("attr-aria-selected=\"tab.isActive ? 'true' : 'false'\"");
    expect(html).toContain("aria-[pressed=true]:font-bold");
    expect(html).toContain('class="shrink-0"\n                      bind-icon=');
    expect(html).toContain("bind-class=\"step.status === 'running' ? 'animate-spin' : ''\"");
    expect(html).toContain("bg-white px-3 py-1.5");
    expect(html).toContain('aria-label="Copy URL"');
    expect(html).toContain('aria-label="Restart run"');
    expect(html).toContain('class="hidden sm:inline"');
    expect(html).toContain("grid-cols-5");
    expect(html).toContain('class="sr-only">{{ tab.label }}</span>');
    expect(html).toContain('<div class="steps-heading sr-only">');
    expect(html).toContain("{{ successfulSteps }} / {{ totalSteps }}");
    expect(html).toContain('attr-aria-label="tab.label"');
    expect(html).toContain("sm:absolute sm:right-0 sm:top-full sm:z-20");
    expect(html).toContain('class="run-actions flex w-full flex-wrap items-center gap-2 shrink-0 sm:w-auto"');
    expect(css).toContain(".run-actions details[open]");
    expect(css).toContain("flex: 0 0 100%");
    expect(css).toContain(".run-actions details[open] > summary");
    expect(css).toContain("margin-left: auto");
    expect(runSetup).toContain('restartError = ref("")');
    expect(runSetup).toContain("result.error || `Restart failed (${response.status})`");
    expect(html).toContain('role="alert"');
  });
});
