import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { buildRunView, renderRunHtml, type RunView } from "./run-view.js";
import type { WorkflowExecutionReport } from "./types.js";
import runSetup from "./run.mjs?raw";

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

  it("injects escaped state and SSE refresh behavior into HTML", () => {
    const unsafe = view("running");
    unsafe.steps[0].logContent = "</script><script>alert(1)</script>";
    const html = renderRunHtml(unsafe);
    const source = html + runSetup;
    expect(source).not.toContain("<script state>");
    expect(source).toContain("{{ report.workflowName }}");
    expect(source).toContain('aria-label="Run metadata"');
    expect(source).toContain('<link rel="stylesheet" href="/on.css" />');
    expect(source).not.toContain('bind-title="report.workflowName"');
    expect(source).toContain('href="/runs"');
    expect(source).toContain('class="run-heading');
    expect(source).toContain('class="detail-meta');
    expect(source).toContain('class="execution');
    expect(source).toContain("bg-flow-background");
    expect(source).toContain("bg-[#1c211e]");
    expect(source).toContain("{{ failedStepMessage }}");
    expect(source).not.toContain("{{ runOrigin }}");
    expect(source).not.toContain("Workflow execution");
    expect(source).toContain('class="flex flex-wrap items-baseline gap-x-2');
    expect(source).toContain('on-click="selectStep(step.index)"');
    expect(source).toContain("attr-aria-pressed=\"step.isSelected ? 'true' : 'false'\"");
    expect(source).toContain("attr-aria-label=\"(step.name || step.id || 'Step') + ', ' + upper(step.status)\"");
    expect(source).toContain('bind-innerhtml="stepLog(selectedStepReport)"');
    expect(source).not.toContain("state.step");
    expect(source).not.toContain("(step, index) of report.steps");
    expect(source).toContain("Logs & steps");
    expect(source).toContain("Search this step's logs");
    expect(source).toContain("toggleLogWrap()");
    expect(source).toContain('aria-label="Copy logs"');
    expect(source).toContain("detailTab !== 'inputs'");
    expect(source).toContain("detailTab !== 'artifacts'");
    expect(source).toContain("detailTab !== 'history'");
    expect(source).toContain('class-active="tab.isActive"');
    expect(source).toContain('class-active="step.isSelected"');
    expect(source).toContain("hover:bg-flow-panel hover:text-flow-primary");
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
    expect(source).toContain("apiFetch(`/api/runs/${jobId}`");
    expect(source).toContain("lucide-icon");
    expect(source).toContain("detailTab !== 'source'");
    expect(source).toContain('theme="googlecode"');
    expect(source).not.toContain("border-t border-gray-800 bg-gray-950");
    expect(source).not.toContain("border-b border-flow-border pb-4");
    expect(source).toContain('bind-source="report.workflowSourceYaml"');
    expect(source).toContain("Get AI help for failed step");
    expect(source).toContain("/ai-help");
    expect(source).toContain("Previous runs");
    expect(source).toContain("body: JSON.stringify({ inputs: report.value.inputs || {} })");
    expect(source).toContain("Original inputs");
    expect(source).toContain("setManualKey(entry, $event)");
    expect(source).toContain("report.value.parentId");
    expect(source).toContain("/api/runs/${parentId}");
    expect(source).toContain("Artifacts");
    expect(source).toContain("Thinking through the failed step");
    expect(source).toContain("marked.parse(content)");
    expect(source).toContain("downloadArtifact($event, artifact)");
    expect(source).toContain("https://sodium.static.apphor.de/code-block.html");
    expect(source).toContain('bind-source="inputsJson"');
    expect(source).toContain("'circle-check'");
    expect(source).toContain("{{ report.workerId || 'Awaiting worker' }}");
    expect(source).toContain("formatTimestampedLogLine");
    expect(source).toContain("formatDate(report.startedAt)");
    expect(source).toContain("/api/preferences");
    expect(source).not.toContain("https://cdn.tailwindcss.com");
    expect(source).toContain('new EventSource("/api/events")');
    expect(source).toContain('addEventListener("jobs.changed", handleJobChange)');
    expect(source).toContain("apiFetch(`/api/runs/${jobId}`");
    expect(source).toContain("now.value = Date.now()");
    expect(source).toContain('href="/manifest.webmanifest"');
    expect(source).toContain('navigator.serviceWorker.register("/service-worker.js")');
    expect(source).toContain("registration.showNotification(");
    expect(source).not.toContain("location.reload()");
    expect(source).not.toContain("</script><script>alert(1)</script>");
    expect(source).not.toContain("unsafe");
  });

  it("gives the selected tab and step a clear active treatment", () => {
    const css = readFileSync(resolve(process.cwd(), "src/index.css"), "utf8");

    expect(css).toContain(".run-detail-tab.active");
    expect(css).toContain("background-color: #e8f0e5");
    expect(css).toContain(".step-button.active");
    expect(css).toContain("0 0 0 1px #387045");
    expect(css).toContain("font-weight: 700");
  });
});
