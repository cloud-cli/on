import type { IncomingMessage, ServerResponse } from "node:http";

export async function readBody(request: IncomingMessage): Promise<string> {
  const chunks: Buffer[] = [];

  for await (const chunk of request) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }

  return Buffer.concat(chunks).toString("utf8");
}
export function sendJson(
  response: ServerResponse,
  statusCode: number,
  body: unknown,
): void {
  response
    .writeHead(statusCode, { "content-type": "application/json" })
    .end(JSON.stringify(body));
}
export function normalizePort(portValue: string): number {
  const port = Number.parseInt(portValue, 10);

  if (!Number.isInteger(port) || port < 0 || port > 65535) {
    throw new Error(
      `Invalid --port value '${portValue}'. Expected an integer from 0 to 65535.`,
    );
  }

  return port;
}
export function asObject(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("Incoming webhook payload must be a JSON object.");
  }

  return value as Record<string, unknown>;
}
export function resolvePath(target: unknown, pathExpression: string): unknown {
  const normalized = pathExpression
    .trim()
    .replace(/^\$\{/, "")
    .replace(/}$/, "");
  const pathParts = normalized.split(".").filter(Boolean);

  let cursor: unknown = target;
  for (const segment of pathParts) {
    if (typeof cursor !== "object" || cursor === null || !(segment in cursor)) {
      return undefined;
    }
    cursor = (cursor as Record<string, unknown>)[segment];
  }

  return cursor;
}
export function interpolate(
  template: string,
  context: Record<string, unknown>,
): string {
  return template.replace(/\$\{([^}]+)}/g, (_all, expression: string) => {
    const value = resolvePath(context, expression);
    if (value === undefined || value === null) {
      return "";
    }
    return String(value);
  });
}
export function withMappings(
  inputs: Record<string, unknown>,
  mappings: Record<string, string> | undefined,
): Record<string, unknown> {
  if (!mappings) {
    return { ...inputs };
  }

  const nextInputs = { ...inputs };
  for (const [field, pathExpression] of Object.entries(mappings)) {
    const normalized = pathExpression.startsWith("${")
      ? pathExpression
      : `\${${pathExpression}}`;
    nextInputs[field] = resolvePath({ inputs: nextInputs }, normalized);
  }

  return nextInputs;
}
