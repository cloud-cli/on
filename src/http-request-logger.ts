import crypto from "node:crypto";
import type { IncomingMessage, ServerResponse } from "node:http";

function requestPath(req: IncomingMessage): string {
  const path = (req.url || "/").split("?", 1)[0];
  return path.replace(/^\/webhooks\/team\/[^/]+/, "/webhooks/team/[REDACTED]");
}

export function startHttpRequestLog(req: IncomingMessage, res: ServerResponse): string {
  const requestId = crypto.randomUUID();
  const startedAt = process.hrtime.bigint();
  const method = req.method || "UNKNOWN";
  const path = requestPath(req);
  let logged = false;

  res.setHeader("X-Request-Id", requestId);
  const writeLog = (outcome: string) => {
    if (logged) {
      return;
    }
    logged = true;
    const durationMs = Number(process.hrtime.bigint() - startedAt) / 1_000_000;
    console.info(`[HTTP] ${requestId} ${method} ${path} ${outcome} ${durationMs.toFixed(1)}ms`);
  };
  res.once("finish", () => writeLog(String(res.statusCode)));
  res.once("close", () => writeLog(res.writableFinished ? String(res.statusCode) : "aborted"));

  return requestId;
}

export function logUnhandledHttpError(req: IncomingMessage, requestId: string, error: unknown): void {
  const method = req.method || "UNKNOWN";
  const path = requestPath(req);
  if (error instanceof Error) {
    const message = error.message
      .replace(/\b(Bearer\s+)\S+/gi, "$1[REDACTED]")
      .replace(/\b(password|secret|token|authorization|cookie)\s*[:=]\s*("[^"]*"|'[^']*'|\S+)/gi, "$1=[REDACTED]");
    const frames = error.stack?.split("\n").slice(1).join("\n");
    console.error(`[HTTP] ${requestId} Unhandled error for ${method} ${path}: ${error.name}: ${message}`, frames || "");
    return;
  }
  console.error(`[HTTP] ${requestId} Unhandled non-Error throw for ${method} ${path}`, typeof error);
}
