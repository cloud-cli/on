import { EventEmitter } from "node:events";
import type { IncomingMessage, ServerResponse } from "node:http";
import { afterEach, describe, expect, it, vi } from "vitest";
import { logUnhandledHttpError, startHttpRequestLog } from "./http-request-logger.js";

function makeRequest(method: string, url: string): IncomingMessage {
  return { method, url } as IncomingMessage;
}

function makeResponse() {
  const response = new EventEmitter() as ServerResponse;
  response.statusCode = 500;
  response.setHeader = vi.fn();
  return response;
}

describe("main server HTTP request logging", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("logs completed request method, path, status, duration, and request ID without query values", () => {
    const info = vi.spyOn(console, "info").mockImplementation(() => {});
    const req = makeRequest("POST", "/api/v1/jobs/42/restart?token=do-not-log");
    const res = makeResponse();

    const requestId = startHttpRequestLog(req, res);
    res.emit("finish");

    expect(res.setHeader).toHaveBeenCalledWith("X-Request-Id", requestId);
    expect(info).toHaveBeenCalledOnce();
    expect(info.mock.calls[0][0]).toMatch(
      new RegExp(`^\\[HTTP\\] ${requestId} POST /api/v1/jobs/42/restart 500 \\d+\\.\\d+ms$`),
    );
    expect(info.mock.calls[0][0]).not.toContain("do-not-log");
  });

  it("logs a disconnected request once", () => {
    const info = vi.spyOn(console, "info").mockImplementation(() => {});
    const res = makeResponse();

    startHttpRequestLog(makeRequest("GET", "/ui/runs"), res);
    res.emit("close");
    res.emit("finish");

    expect(info).toHaveBeenCalledOnce();
    expect(info.mock.calls[0][0]).toContain("GET /ui/runs aborted");
  });

  it("redacts workspace webhook tokens from access logs", () => {
    const info = vi.spyOn(console, "info").mockImplementation(() => {});
    const res = makeResponse();

    startHttpRequestLog(makeRequest("POST", "/webhooks/connectors/private-webhook-token?ref=main"), res);
    res.emit("finish");

    expect(info.mock.calls[0][0]).toContain("POST /webhooks/connectors/[REDACTED]");
    expect(info.mock.calls[0][0]).not.toContain("private-webhook-token");
  });

  it("logs unhandled errors with request context while excluding query values and redacting credentials", () => {
    const errorLog = vi.spyOn(console, "error").mockImplementation(() => {});
    const error = new Error("Bearer sensitive-token database is unavailable");

    logUnhandledHttpError(makeRequest("POST", "/restart/42?token=do-not-log"), "request-42", error);

    expect(errorLog.mock.calls[0][0]).toBe(
      "[HTTP] request-42 Unhandled error for POST /restart/42: Error: Bearer [REDACTED] database is unavailable",
    );
    expect(errorLog.mock.calls[0][1]).toContain("http-request-logger.spec.ts");
    expect(JSON.stringify(errorLog.mock.calls)).not.toContain("do-not-log");
    expect(JSON.stringify(errorLog.mock.calls)).not.toContain("sensitive-token");
  });
});
