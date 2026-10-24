import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ fetch: vi.fn(), init: undefined as (() => void) | undefined }));
vi.mock("@li3/web", () => ({
  ref: (value: unknown) => ({ value }),
  computed: (fn: () => unknown) => ({
    get value() {
      return fn();
    },
  }),
  onInit: (fn: () => void) => {
    mocks.init = fn;
  },
  onDestroy: () => {},
}));
vi.mock("ansi_up", () => ({
  AnsiUp: class {
    ansi_to_html(value: string) {
      return value;
    }
  },
}));
vi.mock("marked", () => ({ marked: { parse: (value: string) => value } }));
vi.mock("@app/api-client.mjs", () => ({ apiFetch: mocks.fetch }));
vi.mock("@app/preferences.mjs", () => ({ loadTimezonePreference: async () => ({}) }));
vi.mock("@app/app-router.mjs", () => ({ navigateTo: () => {} }));
vi.mock("@app/timezone-format.mjs", () => ({ formatTimestampedLogLine: (line: string) => line }));

import setup from "./run.mjs";

const response = (body: unknown, ok = true, status = 200) => ({ ok, status, json: async () => body });

describe("run detail step attempts", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.init = undefined;
    (globalThis as any).window = { location: { pathname: "/ui/runs/42", href: "http://localhost/ui/runs/42" } };
    (globalThis as any).document = { title: "", addEventListener: () => {}, removeEventListener: () => {} };
    (globalThis as any).EventSource = class {
      addEventListener() {}
      close() {}
    };
    (globalThis as any).localStorage = { getItem: () => "" };
    (globalThis as any).setInterval = () => 1;
    (globalThis as any).clearInterval = () => {};
    mocks.fetch.mockImplementation(async (url: string) =>
      url.includes("step-attempts")
        ? response({ attempts: [{ step_id: "a", attempt: 1, log_content: "needle" }] })
        : response({
            jobId: "42",
            workflowName: "wf",
            status: "failed",
            canViewLogs: true,
            canViewInputs: false,
            canViewArtifacts: false,
            steps: [{ id: "a", status: "failed", logContent: "main needle" }],
          }),
    );
  });

  it.each(["500", "network rejection"])("renders run state despite attempts %s", async (failure) => {
    if (failure === "500") {
      mocks.fetch.mockImplementation(async (url: string) =>
        url.includes("step-attempts")
          ? response({}, false, 500)
          : response({
              jobId: "42",
              workflowName: "wf",
              status: "failed",
              canViewLogs: true,
              steps: [{ id: "a", status: "failed" }],
            }),
      );
    } else {
      mocks.fetch.mockImplementation(async (url: string) => {
        if (url.includes("step-attempts")) {
          throw new Error("offline");
        }
        return response({
          jobId: "42",
          workflowName: "wf",
          status: "failed",
          canViewLogs: true,
          steps: [{ id: "a", status: "failed" }],
        });
      });
    }
    const vm = setup();
    mocks.init?.();
    await vi.waitFor(() => expect(vm.report.value.status).toBe("failed"));
    await vi.waitFor(() => expect(vm.attemptsState.value).toBe("error"));
    expect(vm.selectedStep.value).toBe(0);
    expect(vm.detailTabs.value.some((tab: any) => tab.id === "history" && tab.visible)).toBe(true);
    expect(vm.attemptsError.value).toMatch(/could not be loaded/i);
  });

  it("does not wait for a delayed attempt response to reconcile tabs and failed-step selection", async () => {
    let finish!: (value: any) => void;
    mocks.fetch.mockImplementation((url: string) =>
      url.includes("step-attempts")
        ? new Promise((resolve) => {
            finish = resolve;
          })
        : Promise.resolve(
            response({
              jobId: "42",
              workflowName: "wf",
              status: "failed",
              canViewLogs: true,
              steps: [{ id: "a", status: "failed" }],
            }),
          ),
    );
    const vm = setup();
    mocks.init?.();
    await vi.waitFor(() => expect(vm.report.value.status).toBe("failed"));
    expect(vm.detailTabs.value.some((tab: any) => tab.id === "logs" && tab.visible)).toBe(true);
    expect(vm.selectedStep.value).toBe(0);
    finish(response({ attempts: [] }));
    await vi.waitFor(() => expect(vm.attemptsState.value).toBe("loaded"));
  });

  it("does not retain attempts when log access is revoked during the request", async () => {
    let finish!: (value: any) => void;
    mocks.fetch.mockImplementation((url: string) =>
      url.includes("step-attempts")
        ? new Promise((resolve) => {
            finish = resolve;
          })
        : Promise.resolve(
            response({
              jobId: "42",
              status: "failed",
              canViewLogs: true,
              steps: [{ id: "a", status: "failed" }],
            }),
          ),
    );
    const vm = setup();
    mocks.init?.();
    await vi.waitFor(() => expect(vm.report.value.status).toBe("failed"));
    vm.report.value.canViewLogs = false;
    finish(response({ attempts: [{ step_id: "a", attempt: 1, log_content: "private log" }] }));
    await vi.waitFor(() => expect(vm.attemptsForStep({ id: "a" })).toEqual([]));
  });

  it("times out a hung attempt request and allows retry", async () => {
    const nativeSetTimeout = globalThis.setTimeout;
    const timeoutSpy = vi
      .spyOn(globalThis, "setTimeout")
      .mockImplementation(
        (handler: any, timeout?: number, ...args: any[]) =>
          nativeSetTimeout(handler, timeout === 15_000 ? 0 : timeout, ...args) as any,
      );
    let attemptRequests = 0;
    mocks.fetch.mockImplementation((url: string, init: RequestInit = {}) => {
      if (url.includes("step-attempts")) {
        attemptRequests += 1;
        if (attemptRequests === 1) {
          return new Promise((_resolve, reject) => {
            init.signal?.addEventListener("abort", () => reject(new Error("aborted")), { once: true });
          });
        }
        return Promise.resolve(response({ attempts: [] }));
      }
      return Promise.resolve(
        response({
          jobId: "42",
          workflowName: "wf",
          status: "failed",
          canViewLogs: true,
          steps: [{ id: "a", status: "failed" }],
        }),
      );
    });

    try {
      const vm = setup();
      mocks.init?.();
      await vi.waitFor(() => expect(vm.attemptsState.value).toBe("error"));
      mocks.fetch.mockImplementation(async (url: string) =>
        url.includes("step-attempts") ? response({ attempts: [] }) : response({ jobId: "42", status: "failed" }),
      );
      await vm.retryStepAttempts();
      expect(vm.attemptsState.value).toBe("loaded");
      expect(attemptRequests).toBe(1);
    } finally {
      timeoutSpy.mockRestore();
    }
  });

  it("supports retry and applies search and wrap controls across displayed log output", async () => {
    const vm = setup();
    mocks.init?.();
    await vi.waitFor(() => expect(vm.attemptsState.value).toBe("loaded"));
    mocks.fetch.mockImplementation(async (url: string) =>
      url.includes("step-attempts")
        ? response({}, false, 500)
        : response({ jobId: "42", status: "failed", canViewLogs: true, steps: [{ id: "a", status: "failed" }] }),
    );
    vm.attemptsState.value = "error";
    await vm.retryStepAttempts();
    expect(vm.attemptsState.value).toBe("error");
    expect(vm.attemptLog({ log_content: "needle\nother" })).toContain("needle");
    vm.setLogSearch({ target: { value: "other" } });
    expect(vm.attemptLog({ log_content: "needle\nother" })).toContain("other");
    expect(vm.attemptLog({ log_content: '<img src=x onerror="alert(1)">' })).not.toContain("<img");
    expect(vm.stepLog({ status: "success", logContent: "needle\nother" })).toContain("other");
    vm.toggleLogWrap();
    expect(vm.wrapLogs.value).toBe(false);
  });

  it("labels each attempt when copying the visible log history", async () => {
    const copied: string[] = [];
    Object.defineProperty(globalThis, "navigator", {
      configurable: true,
      value: { clipboard: { writeText: async (value: string) => copied.push(value) } },
    });
    mocks.fetch.mockImplementation(async (url: string) =>
      url.includes("step-attempts")
        ? response({
            attempts: [
              { step_id: "build", attempt: 1, status: "failed", log_content: "first output" },
              { step_id: "build", attempt: 2, status: "success", log_content: "second output" },
            ],
          })
        : response({
            jobId: "42",
            canViewLogs: true,
            steps: [{ id: "build", status: "success", logContent: "latest output" }],
          }),
    );
    const vm = setup();
    mocks.init?.();
    await vi.waitFor(() => expect(vm.attemptsState.value).toBe("loaded"));

    await vm.copyLogs();

    expect(copied[0]).toContain("Current step log (build):");
    expect(copied[0]).toContain("Attempt 1 (failed):");
    expect(copied[0]).toContain("Attempt 2 (success):");
  });
});
