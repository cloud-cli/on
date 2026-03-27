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

export function asObject<T extends Record<string, unknown>>(value: unknown): T {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("Incoming webhook payload must be a JSON object.");
  }

  return value as T;
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

export function toStringProxy<T>(value: unknown): T {
  if (typeof value === "object" && value !== null) {
    return new Proxy(value, {
      get(target, prop) {
        const result = Reflect.get(target, prop);
        if (typeof result === "object" && result !== null) {
          return toStringProxy(result);
        }

        if (prop === "toString") {
          return () => "'" + JSON.stringify(target) + "'";
        }

        return result;
      },
    }) as T;
  }

  if (value === undefined || value === null) {
    return "" as T;
  }

  return value as T;
}

export function interpolate(template: string, context: any): string {
  const keys = Object.keys(context);
  const f = Function(
    "context",
    "const { " + keys.join(", ") + " } = context;return `" + template + "`;",
  );

  return String(f(context) || "");
}

export function withMappings(
  inputs: Record<string, unknown>,
  mappings: Record<string, string> | undefined,
): Record<string, unknown> {
  if (!mappings) {
    return { ...inputs };
  }

  const context = { inputs };
  for (const [field, pathExpression] of Object.entries(mappings)) {
    context.inputs[field] = interpolate(`\${${pathExpression}}`, context);
  }

  return context.inputs;
}
