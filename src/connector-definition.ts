import { parse } from "yaml";
import { parseExpressionAt } from "acorn";
import { SafeExpressionEvaluator } from "./safe-eval.js";

const MAX_YAML_LENGTH = 256_000;
const MAX_EXPRESSION_LENGTH = 8_192;
const MAX_STEPS = 32;
const ID_PATTERN = /^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/;
const EVENT_TYPE_PATTERN = /^[a-z][a-z0-9]*(?:[._-][a-z0-9]+)*$/;
const SAFE_METHOD_CALLS = new Set([
  "toString",
  "toLowerCase",
  "toUpperCase",
  "trim",
  "slice",
  "substring",
  "startsWith",
  "endsWith",
  "includes",
  "indexOf",
  "lastIndexOf",
  "charAt",
]);

function validateExpression(code: string): void {
  const ast = parseExpressionAt(code, 0, { ecmaVersion: 2020 }) as Record<string, any>;
  let nodes = 0;
  const visit = (node: any, depth: number): void => {
    if (!node || typeof node !== "object" || typeof node.type !== "string") {
      return;
    }
    nodes += 1;
    if (nodes > 1024 || depth > 48) {
      throw new Error("Connector expression exceeds the complexity limit");
    }
    if (node.type === "MemberExpression") {
      const property = node.computed ? node.property.value : node.property.name;
      if (["constructor", "__proto__", "prototype"].includes(property)) {
        throw new Error("Connector expressions cannot access object internals");
      }
    }
    if (node.type === "CallExpression") {
      const callee = node.callee;
      const safeHelper = callee.type === "Identifier" && ["String", "Number", "Boolean"].includes(callee.name);
      const safeJson =
        callee.type === "MemberExpression" &&
        callee.object.type === "Identifier" &&
        callee.object.name === "JSON" &&
        ["parse", "stringify"].includes(callee.computed ? callee.property.value : callee.property.name);
      const safeMethod =
        callee.type === "MemberExpression" &&
        SAFE_METHOD_CALLS.has(callee.computed ? callee.property.value : callee.property.name);
      if (!safeHelper && !safeJson && !safeMethod) {
        throw new Error("Connector expressions may call only bounded data and JSON helpers");
      }
    }
    for (const [key, value] of Object.entries(node)) {
      if (["start", "end", "loc"].includes(key)) {
        continue;
      }
      if (Array.isArray(value)) {
        for (const child of value) {
          visit(child, depth + 1);
        }
      } else {
        visit(value, depth + 1);
      }
    }
  };
  visit(ast, 0);
}

export interface ConnectorDefinition {
  kind: "connector";
  id: string;
  name: string;
  steps: Array<{ id: string; eval: string }>;
}

export interface ConnectorContext {
  input: { contentType?: unknown; body?: unknown; [key: string]: unknown };
  headers?: Record<string, unknown>;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    return false;
  }
  const proto = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
}

function assertJsonSafe(value: unknown, path = "context", seen = new Set<object>()): void {
  if (value === null || typeof value === "string" || typeof value === "boolean") {
    return;
  }
  if (typeof value === "number" && Number.isFinite(value)) {
    return;
  }
  if (typeof value !== "object") {
    throw new Error(`${path} must contain only JSON-safe values`);
  }
  if (seen.has(value)) {
    throw new Error(`${path} must not contain cycles`);
  }
  if (!Array.isArray(value) && !isRecord(value)) {
    throw new Error(`${path} must contain only plain JSON objects and arrays`);
  }
  seen.add(value);
  for (const child of Array.isArray(value) ? value : Object.values(value)) {
    assertJsonSafe(child, path, seen);
  }
  seen.delete(value);
}

export function parseConnectorDefinition(sourceYaml: string): ConnectorDefinition {
  if (typeof sourceYaml !== "string" || sourceYaml.length > MAX_YAML_LENGTH) {
    throw new Error(`Connector YAML must be at most ${MAX_YAML_LENGTH} characters`);
  }
  const value: unknown = parse(sourceYaml, { uniqueKeys: true });
  if (!isRecord(value)) {
    throw new Error("Connector definition must be an object");
  }
  const keys = Object.keys(value);
  if (keys.some((key) => !["kind", "id", "name", "steps"].includes(key))) {
    throw new Error("Connector definition contains unsupported keys");
  }
  if (value.kind !== "connector") {
    throw new Error("Connector kind must be 'connector'");
  }
  if (typeof value.id !== "string" || !ID_PATTERN.test(value.id)) {
    throw new Error("Connector id must be a lowercase slug");
  }
  if (typeof value.name !== "string" || !value.name.trim()) {
    throw new Error("Connector name must be nonempty");
  }
  if (!Array.isArray(value.steps) || value.steps.length === 0 || value.steps.length > MAX_STEPS) {
    throw new Error(`Connector must have between 1 and ${MAX_STEPS} steps`);
  }
  const ids = new Set<string>();
  const steps = value.steps.map((step: unknown) => {
    if (!isRecord(step) || Object.keys(step).some((key) => !["id", "eval"].includes(key))) {
      throw new Error("Connector steps may contain only id and eval; run steps are unsupported");
    }
    if (typeof step.id !== "string" || !ID_PATTERN.test(step.id) || ids.has(step.id)) {
      throw new Error("Connector step IDs must be unique lowercase slugs");
    }
    if (typeof step.eval !== "string" || !step.eval.trim() || step.eval.length > MAX_EXPRESSION_LENGTH) {
      throw new Error(`Connector step eval must be nonempty and at most ${MAX_EXPRESSION_LENGTH} characters`);
    }
    try {
      validateExpression(step.eval);
    } catch (error) {
      throw new Error(error instanceof Error ? error.message : "Connector expression is invalid");
    }
    ids.add(step.id);
    return { id: step.id, eval: step.eval };
  });
  return { kind: "connector", id: value.id, name: value.name, steps };
}

function validateOutput(value: unknown): { type: string; data: Record<string, unknown> } {
  if (!isRecord(value) || Object.keys(value).some((key) => !["type", "data"].includes(key))) {
    throw new Error("Connector result must contain only type and data");
  }
  if (typeof value.type !== "string" || !EVENT_TYPE_PATTERN.test(value.type) || !isRecord(value.data)) {
    throw new Error("Connector result requires a valid event type and plain object data");
  }
  assertJsonSafe(value, "connector result");
  let serialized: string | undefined;
  try {
    serialized = JSON.stringify(value);
  } catch {
    throw new Error("Connector result must be JSON serializable");
  }
  if (serialized === undefined || new TextEncoder().encode(serialized).byteLength > MAX_YAML_LENGTH) {
    throw new Error(`Connector result must serialize to at most ${MAX_YAML_LENGTH} UTF-8 bytes`);
  }
  return { type: value.type, data: value.data };
}

export async function evaluateConnector(
  sourceYaml: string,
  context: ConnectorContext,
): Promise<{ type: string; data: Record<string, unknown> }> {
  const definition = parseConnectorDefinition(sourceYaml);
  if (!isRecord(context) || !isRecord(context.input)) {
    throw new Error("Connector context must include a plain input object");
  }
  assertJsonSafe(context.input);
  const headers = context.headers ?? {};
  if (!isRecord(headers)) {
    throw new Error("Connector headers must be a plain object");
  }
  assertJsonSafe(headers, "headers");
  const outputs: Record<string, unknown> = {};
  const baseContext = { input: context.input, body: context.input.body, headers };
  for (const step of definition.steps) {
    outputs[step.id] = await SafeExpressionEvaluator.evaluateExpression(step.eval, {
      ...baseContext,
      steps: { ...outputs },
    });
  }
  return validateOutput(outputs[definition.steps[definition.steps.length - 1].id]);
}
