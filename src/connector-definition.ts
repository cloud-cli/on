import { parse } from "yaml";
import * as acorn from "acorn";
import { createHmac, timingSafeEqual } from "node:crypto";
import { safeWebhookHeaders } from "./webhook-headers.js";

const MAX_YAML_LENGTH = 256_000;
const MAX_PROGRAM_LENGTH = 8_192;
const MAX_NODES = 1024;
const MAX_DEPTH = 48;
const MAX_STEPS = 10_000;
const MAX_JSON_DEPTH = 64;
const MAX_JSON_NODES = 50_000;
const MAX_HEADER_BYTES = 64_000;
const EVENT_TYPE_PATTERN = /^[a-z][a-z0-9]*(?:[._-][a-z0-9]+)*$/;
const BLOCKED_PROPERTIES = new Set(["constructor", "__proto__", "prototype"]);
const SAFE_METHODS = new Set([
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

export interface ConnectorDefinition {
  run: string;
}
export interface ConnectorContext {
  inputs: Record<string, unknown>;
  body: Buffer;
  headers: Record<string, string>;
  secrets: { WEBHOOK_SECRET?: string };
  contentType?: string;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    return false;
  }
  const proto = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
}

function assertJsonSafe(
  value: unknown,
  path = "context",
  seen = new Set<object>(),
  depth = 0,
  state = { nodes: 0 },
): void {
  if (++state.nodes > MAX_JSON_NODES || depth > MAX_JSON_DEPTH) {
    throw new Error(`${path} exceeds the JSON complexity limit`);
  }
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
  const children = Array.isArray(value) ? value : Object.values(value);
  if (children.length > MAX_JSON_NODES) {
    throw new Error(`${path} exceeds the JSON collection limit`);
  }
  for (const child of children) {
    assertJsonSafe(child, path, seen, depth + 1, state);
  }
  seen.delete(value);
}

function parseProgram(code: string): any {
  if (typeof code !== "string" || !code.trim() || code.length > MAX_PROGRAM_LENGTH) {
    throw new Error(`Connector run must be nonempty and at most ${MAX_PROGRAM_LENGTH} characters`);
  }
  let ast: any;
  try {
    ast = acorn.parse(code, { ecmaVersion: 2020 });
  } catch (error) {
    throw new Error(`Invalid connector program: ${error instanceof Error ? error.message : "syntax error"}`);
  }
  let nodes = 0;
  const visit = (node: any, depth: number): void => {
    if (!node || typeof node !== "object" || typeof node.type !== "string") {
      return;
    }
    if (++nodes > MAX_NODES || depth > MAX_DEPTH) {
      throw new Error("Connector program exceeds the complexity limit");
    }
    if (
      node.type === "MemberExpression" &&
      node.computed &&
      node.property.type === "Literal" &&
      BLOCKED_PROPERTIES.has(String(node.property.value))
    ) {
      throw new Error("Connector expressions cannot access object internals");
    }
    if (node.type === "MemberExpression" && !node.computed && BLOCKED_PROPERTIES.has(node.property.name)) {
      throw new Error("Connector expressions cannot access object internals");
    }
    for (const [key, value] of Object.entries(node)) {
      if (["start", "end", "loc"].includes(key)) {
        continue;
      }
      if (Array.isArray(value)) {
        value.forEach((child) => visit(child, depth + 1));
      } else {
        visit(value, depth + 1);
      }
    }
  };
  visit(ast, 0);
  const validateExpression = (node: any): void => {
    switch (node.type) {
      case "Literal":
      case "Identifier":
        return;
      case "ObjectExpression":
        for (const property of node.properties) {
          if (property.type !== "Property" || property.kind !== "init" || property.method || property.shorthand) {
            throw new Error("Connector objects may contain only explicit data properties");
          }
          if (property.computed) {
            validateExpression(property.key);
          }
          validateExpression(property.value);
        }
        return;
      case "ArrayExpression":
        for (const item of node.elements) {
          if (!item || item.type === "SpreadElement") {
            throw new Error("Connector arrays do not support holes or spread values");
          }
          validateExpression(item);
        }
        return;
      case "MemberExpression":
        validateExpression(node.object);
        if (node.computed) {
          validateExpression(node.property);
        }
        return;
      case "CallExpression": {
        const callee = node.callee;
        const allowedIdentifierCall =
          callee.type === "Identifier" && ["String", "Number", "Boolean", "emit", "verifyBody"].includes(callee.name);
        const allowedJsonCall =
          callee.type === "MemberExpression" &&
          callee.object.type === "Identifier" &&
          callee.object.name === "JSON" &&
          ["parse", "stringify"].includes(callee.computed ? callee.property.value : callee.property.name);
        const allowedMethodCall =
          callee.type === "MemberExpression" &&
          SAFE_METHODS.has(callee.computed ? callee.property.value : callee.property.name);
        if (!allowedIdentifierCall && !allowedJsonCall && !allowedMethodCall) {
          throw new Error("Connector calls only support emit, verifyBody, bounded methods, and JSON helpers");
        }
        if (callee.type === "MemberExpression") {
          validateExpression(callee.object);
          if (callee.computed) {
            validateExpression(callee.property);
          }
        }
        for (const argument of node.arguments) {
          if (!argument || argument.type === "SpreadElement") {
            throw new Error("Connector calls do not support spread arguments");
          }
          validateExpression(argument);
        }
        return;
      }
      case "ConditionalExpression":
        validateExpression(node.test);
        validateExpression(node.consequent);
        validateExpression(node.alternate);
        return;
      case "LogicalExpression":
      case "BinaryExpression":
        validateExpression(node.left);
        validateExpression(node.right);
        return;
      case "UnaryExpression":
        validateExpression(node.argument);
        return;
      case "ChainExpression":
        validateExpression(node.expression);
        return;
      default:
        throw new Error(`Disallowed connector expression '${node.type}'`);
    }
  };
  const validateStatement = (statement: any): void => {
    switch (statement.type) {
      case "Program":
      case "BlockStatement":
        for (const child of statement.body) {
          validateStatement(child);
        }
        return;
      case "IfStatement":
        validateExpression(statement.test);
        validateStatement(statement.consequent);
        if (statement.alternate) {
          validateStatement(statement.alternate);
        }
        return;
      case "ExpressionStatement":
        validateExpression(statement.expression);
        return;
      case "ThrowStatement": {
        const thrown = statement.argument;
        if (
          thrown.type !== "NewExpression" ||
          thrown.callee.type !== "Identifier" ||
          thrown.callee.name !== "Error" ||
          thrown.arguments.length !== 1
        ) {
          throw new Error("Only throw new Error(message) is permitted");
        }
        validateExpression(thrown.arguments[0]);
        return;
      }
      default:
        throw new Error(`Disallowed connector statement '${statement.type}'`);
    }
  };
  validateStatement(ast);
  return ast;
}

export function parseConnectorDefinition(
  sourceYaml: string,
  options: { allowLegacy?: boolean } = {},
): ConnectorDefinition | LegacyConnectorDefinition {
  if (typeof sourceYaml !== "string" || sourceYaml.length > MAX_YAML_LENGTH) {
    throw new Error(`Connector YAML must be at most ${MAX_YAML_LENGTH} characters`);
  }
  const value: unknown = parse(sourceYaml, { uniqueKeys: true });
  if (options.allowLegacy && isRecord(value) && value.kind === "connector") {
    return parseLegacyDefinition(value);
  }
  if (!isRecord(value) || Object.keys(value).length !== 1 || !Object.hasOwn(value, "run")) {
    throw new Error("Connector definition must contain only a top-level run program");
  }
  if (typeof value.run !== "string") {
    throw new Error("Connector run must be a YAML block string");
  }
  parseProgram(value.run);
  return { run: value.run };
}

interface LegacyConnectorDefinition {
  kind: "connector";
  id: string;
  name: string;
  steps: Array<{ id: string; eval: string }>;
}

function parseLegacyDefinition(value: Record<string, unknown>): LegacyConnectorDefinition {
  if (
    Object.keys(value).sort().join(",") !== "id,kind,name,steps" ||
    value.kind !== "connector" ||
    typeof value.id !== "string" ||
    !/^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/.test(value.id) ||
    value.id.length > 64 ||
    typeof value.name !== "string" ||
    !value.name.trim() ||
    value.name.length > 200 ||
    !Array.isArray(value.steps) ||
    value.steps.length < 1 ||
    value.steps.length > 32
  ) {
    throw new Error("Invalid legacy connector definition");
  }
  const ids = new Set<string>();
  const steps = value.steps.map((step) => {
    if (
      !isRecord(step) ||
      Object.keys(step).sort().join(",") !== "eval,id" ||
      typeof step.id !== "string" ||
      !/^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/.test(step.id) ||
      step.id.length > 64 ||
      ids.has(step.id) ||
      typeof step.eval !== "string" ||
      !step.eval.trim() ||
      step.eval.length > MAX_PROGRAM_LENGTH
    ) {
      throw new Error("Invalid legacy connector step");
    }
    ids.add(step.id);
    const ast = parseProgram(`(${step.eval})`);
    if (
      ast.body.length !== 1 ||
      ast.body[0].type !== "ExpressionStatement" ||
      containsForbiddenLegacyCall(ast.body[0].expression)
    ) {
      throw new Error("Legacy connector expression contains an unsupported helper");
    }
    return { id: step.id, eval: step.eval };
  });
  return { kind: "connector", id: value.id, name: value.name, steps };
}

function containsForbiddenLegacyCall(node: any): boolean {
  if (!node || typeof node !== "object") {
    return false;
  }
  if (
    node.type === "CallExpression" &&
    node.callee.type === "Identifier" &&
    ["emit", "verifyBody"].includes(node.callee.name)
  ) {
    return true;
  }
  return Object.entries(node).some(
    ([key, child]) =>
      !["start", "end"].includes(key) &&
      (Array.isArray(child) ? child.some(containsForbiddenLegacyCall) : containsForbiddenLegacyCall(child)),
  );
}

export function parseConnectorInputs(body: Buffer, contentType: string): Record<string, unknown> {
  if (!Buffer.isBuffer(body) || body.byteLength > MAX_YAML_LENGTH) {
    throw new Error("Connector body exceeds the size limit");
  }
  if (contentType !== "application/json" && !contentType.endsWith("+json")) {
    return {};
  }
  const parsed: unknown = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(body));
  if (!isRecord(parsed)) {
    throw new Error("JSON webhook inputs must be an object");
  }
  assertJsonSafe(parsed, "inputs");
  return parsed;
}

function validateOutput(value: unknown): { type: string; data: Record<string, unknown> } {
  if (!isRecord(value) || Object.keys(value).some((key) => !["type", "data"].includes(key))) {
    throw new Error("Connector result must contain only type and data");
  }
  if (typeof value.type !== "string" || !EVENT_TYPE_PATTERN.test(value.type) || !isRecord(value.data)) {
    throw new Error("Connector result requires a valid event type and plain object data");
  }
  assertJsonSafe(value, "connector result");
  const serialized = JSON.stringify(value);
  if (serialized === undefined || new TextEncoder().encode(serialized).byteLength > MAX_YAML_LENGTH) {
    throw new Error(`Connector result must serialize to at most ${MAX_YAML_LENGTH} UTF-8 bytes`);
  }
  return { type: value.type, data: value.data };
}

type Env = Record<string, any>;
function evaluateExpression(node: any, env: Env): any {
  switch (node.type) {
    case "Literal":
      return node.value;
    case "Identifier":
      if (Object.hasOwn(env, node.name)) {
        return env[node.name];
      }
      throw new Error(`Unknown connector identifier '${node.name}'`);
    case "ObjectExpression": {
      const result: Record<string, unknown> = Object.create(null);
      for (const property of node.properties) {
        if (
          property.type !== "Property" ||
          property.kind !== "init" ||
          property.method ||
          (property.computed && property.key.type === "PrivateIdentifier")
        ) {
          throw new Error("Unsupported object property");
        }
        const key = property.computed
          ? evaluateExpression(property.key, env)
          : (property.key.name ?? property.key.value);
        if (typeof key !== "string" && typeof key !== "number") {
          throw new Error("Object keys must be strings or numbers");
        }
        if (BLOCKED_PROPERTIES.has(String(key))) {
          throw new Error("Connector expressions cannot create object internals");
        }
        result[String(key)] = evaluateExpression(property.value, env);
      }
      return result;
    }
    case "ArrayExpression":
      return node.elements.map((item: any) => (item ? evaluateExpression(item, env) : null));
    case "MemberExpression": {
      const object = evaluateExpression(node.object, env);
      if (node.optional && object == null) {
        return undefined;
      }
      if (object == null) {
        throw new Error("Cannot access a property of null or undefined");
      }
      const key = String(node.computed ? evaluateExpression(node.property, env) : node.property.name);
      if (BLOCKED_PROPERTIES.has(key)) {
        throw new Error("Connector expressions cannot access object internals");
      }
      if (typeof object === "string" || Array.isArray(object)) {
        if (key === "length") {
          return object.length;
        }
      }
      if (Buffer.isBuffer(object)) {
        if (key === "length") {
          return object.length;
        }
        if (key !== "toString") {
          throw new Error("Unsafe Buffer property access");
        }
        return { __safeBufferToString: true, buffer: object };
      }
      if (!isRecord(object) && !Array.isArray(object) && typeof object !== "string") {
        throw new Error("Unsafe connector property access");
      }
      return object[key];
    }
    case "CallExpression": {
      const callee = node.callee;
      const args = node.arguments.map((arg: any) => evaluateExpression(arg, env));
      if (callee.type === "Identifier" && ["String", "Number", "Boolean"].includes(callee.name)) {
        if (args.length > 1) {
          throw new Error("Helper accepts at most one argument");
        }
        return callee.name === "String"
          ? String(args[0] ?? "")
          : callee.name === "Number"
            ? Number(args[0])
            : Boolean(args[0]);
      }
      if (callee.type === "Identifier" && callee.name === "emit") {
        if (args.length !== 2) {
          throw new Error("emit accepts an event type and data object");
        }
        env.__emit(args[0], args[1]);
        return undefined;
      }
      if (callee.type === "Identifier" && callee.name === "verifyBody") {
        if (args.length !== 2) {
          throw new Error("verifyBody accepts body and signature");
        }
        return env.__verifyBody(args[0], args[1]);
      }
      if (callee.type === "MemberExpression" && callee.object.type === "Identifier" && callee.object.name === "JSON") {
        const method = callee.computed ? evaluateExpression(callee.property, env) : callee.property.name;
        if (
          method === "parse" &&
          args.length === 1 &&
          typeof args[0] === "string" &&
          args[0].length <= MAX_YAML_LENGTH
        ) {
          return JSON.parse(args[0]);
        }
        if (method === "stringify" && args.length >= 1 && args.length <= 3) {
          assertJsonSafe(args[0], "JSON value");
          const result = JSON.stringify(args[0]);
          if (result === undefined || result.length > MAX_YAML_LENGTH) {
            throw new Error("JSON result exceeds the size limit");
          }
          return result;
        }
        throw new Error("Unsupported JSON helper call");
      }
      if (callee.type !== "MemberExpression") {
        throw new Error("Connector expressions may call only bounded data and JSON helpers");
      }
      const receiver = evaluateExpression(callee.object, env);
      const method = String(callee.computed ? evaluateExpression(callee.property, env) : callee.property.name);
      if (receiver === env.Buffer && method === "from") {
        return env.Buffer.from(...args);
      }
      if (!SAFE_METHODS.has(method)) {
        throw new Error("Connector expressions may call only bounded data and JSON helpers");
      }
      if (method === "toString" && Buffer.isBuffer(receiver)) {
        const encoding = args[0] ?? "utf8";
        if (!["utf8", "utf-8", "base64", "hex", "ascii", "latin1"].includes(encoding)) {
          throw new Error("Unsupported Buffer encoding");
        }
        if (args.length > 1) {
          throw new Error("Buffer.toString accepts at most one encoding");
        }
        return receiver.toString(encoding as BufferEncoding);
      }
      if (typeof receiver !== "string" && !Array.isArray(receiver)) {
        throw new Error("Safe methods require a string or array");
      }
      const fn = (receiver as any)[method];
      if (typeof fn !== "function") {
        throw new Error("Invalid safe method");
      }
      if (method === "slice" || method === "substring") {
        if (args.length > 2 || args.some((n) => !Number.isInteger(n) || Math.abs(n) > MAX_PROGRAM_LENGTH)) {
          throw new Error("String range exceeds the limit");
        }
      } else if (args.length > 1) {
        throw new Error("Safe method accepts at most one argument");
      }
      const result = fn.apply(receiver, args);
      if (typeof result === "string" && result.length > MAX_PROGRAM_LENGTH) {
        throw new Error("String result exceeds the limit");
      }
      return result;
    }
    case "ConditionalExpression":
      return evaluateExpression(node.test, env)
        ? evaluateExpression(node.consequent, env)
        : evaluateExpression(node.alternate, env);
    case "LogicalExpression": {
      const left = evaluateExpression(node.left, env);
      if (node.operator === "&&") {
        return left ? evaluateExpression(node.right, env) : left;
      }
      if (node.operator === "||") {
        return left ? left : evaluateExpression(node.right, env);
      }
      if (node.operator === "??") {
        return left ?? evaluateExpression(node.right, env);
      }
      throw new Error("Unsupported logical operator");
    }
    case "BinaryExpression": {
      const a = evaluateExpression(node.left, env),
        b = evaluateExpression(node.right, env);
      switch (node.operator) {
        case "===":
          return a === b;
        case "!==":
          return a !== b;
        case "==":
          return a == b;
        case "!=":
          return a != b;
        case ">":
          return a > b;
        case "<":
          return a < b;
        case ">=":
          return a >= b;
        case "<=":
          return a <= b;
        case "+":
          return a + b;
        case "-":
          return a - b;
        case "*":
          return a * b;
        case "/":
          return a / b;
        case "%":
          return a % b;
        default:
          throw new Error(`Unsupported binary operator '${node.operator}'`);
      }
    }
    case "UnaryExpression": {
      const value = evaluateExpression(node.argument, env);
      if (node.operator === "!") {
        return !value;
      }
      if (node.operator === "-") {
        return -value;
      }
      if (node.operator === "+") {
        return +value;
      }
      if (node.operator === "typeof") {
        return typeof value;
      }
      throw new Error(`Unsupported unary operator '${node.operator}'`);
    }
    case "ChainExpression":
      return evaluateExpression(node.expression, env);
    default:
      throw new Error(`Disallowed connector expression '${node.type}'`);
  }
}

function evaluateProgram(program: any, env: Env): unknown {
  let count = 0;
  const execute = (statement: any): unknown => {
    if (++count > MAX_STEPS) {
      throw new Error("Connector program exceeded the execution limit");
    }
    switch (statement.type) {
      case "Program": {
        let result: unknown;
        for (const item of statement.body) {
          result = execute(item);
        }
        return result;
      }
      case "BlockStatement": {
        let result: unknown;
        for (const item of statement.body) {
          result = execute(item);
        }
        return result;
      }
      case "ExpressionStatement":
        return evaluateExpression(statement.expression, env);
      case "IfStatement":
        return evaluateExpression(statement.test, env)
          ? execute(statement.consequent)
          : statement.alternate
            ? execute(statement.alternate)
            : undefined;
      case "ThrowStatement": {
        const thrown = statement.argument;
        if (
          thrown.type !== "NewExpression" ||
          thrown.callee.type !== "Identifier" ||
          thrown.callee.name !== "Error" ||
          thrown.arguments.length !== 1
        ) {
          throw new Error("Only throw new Error(message) is permitted");
        }
        const message = evaluateExpression(thrown.arguments[0], env);
        throw new Error(String(message));
      }
      default:
        throw new Error(`Disallowed connector statement '${statement.type}'`);
    }
  };
  return execute(program);
}

export async function evaluateConnector(
  sourceYaml: string,
  context: ConnectorContext,
): Promise<Array<{ type: string; data: Record<string, unknown> }>> {
  const definition = parseConnectorDefinition(sourceYaml, { allowLegacy: true });
  if (!isRecord(context) || !isRecord(context.inputs)) {
    throw new Error("Connector context must include plain inputs");
  }
  assertJsonSafe(context.inputs, "inputs");
  if (!Buffer.isBuffer(context.body)) {
    throw new Error("Connector body must be a raw Buffer");
  }
  if (context.body.byteLength > MAX_YAML_LENGTH) {
    throw new Error("Connector body exceeds the size limit");
  }
  const headers = context.headers;
  if (
    !isRecord(headers) ||
    Object.keys(headers).length > 200 ||
    Object.entries(headers).some(
      ([name, value]) => name.length > 256 || typeof value !== "string" || value.length > 8192,
    )
  ) {
    throw new Error("Connector headers must be a filtered plain string record");
  }
  const headerBytes = Object.entries(headers).reduce(
    (total, [name, value]) => total + Buffer.byteLength(name + value),
    0,
  );
  if (headerBytes > MAX_HEADER_BYTES) {
    throw new Error("Connector headers exceed the size limit");
  }
  assertJsonSafe(headers, "headers");
  const secrets = context.secrets;
  if (
    !isRecord(secrets) ||
    Object.keys(secrets).some((key) => key !== "WEBHOOK_SECRET") ||
    (secrets.WEBHOOK_SECRET !== undefined && typeof secrets.WEBHOOK_SECRET !== "string")
  ) {
    throw new Error("Connector secrets must contain only an optional WEBHOOK_SECRET string");
  }
  if ("kind" in definition) {
    if (secrets.WEBHOOK_SECRET) {
      throw new Error("Legacy connectors with a webhook secret must be updated to the run format before ingress");
    }
    let legacyBody: unknown;
    const contentType = String(context.contentType || "application/octet-stream")
      .split(";", 1)[0]
      .trim()
      .toLowerCase();
    let legacyText: string | undefined;
    try {
      legacyText = new TextDecoder("utf-8", { fatal: true }).decode(context.body);
    } catch {
      legacyText = undefined;
    }
    if (legacyText === undefined) {
      legacyBody = {
        encoding: "base64",
        data: context.body.toString("base64"),
        byteLength: context.body.byteLength,
      };
    } else if (contentType === "application/json" || contentType.endsWith("+json")) {
      try {
        legacyBody = JSON.parse(legacyText);
      } catch {
        legacyBody = legacyText;
      }
    } else {
      legacyBody = legacyText;
    }
    assertJsonSafe(legacyBody, "legacy body");
    const legacySteps: Record<string, unknown> = Object.create(null);
    const legacyEnv = {
      body: legacyBody,
      input: { contentType, body: legacyBody },
      inputs: legacyBody,
      headers: safeWebhookHeaders(headers),
      steps: legacySteps,
    };
    let result: unknown;
    for (const step of definition.steps) {
      const stepAst = parseProgram(`(${step.eval})`);
      result = evaluateExpression(stepAst.body[0].expression, legacyEnv);
      legacySteps[step.id] = result;
    }
    return [validateOutput(result)];
  }
  const events: Array<{ type: string; data: Record<string, unknown> }> = [];
  let emittedBytes = 0;
  const env: Env = {
    inputs: context.inputs,
    body: context.body,
    headers,
    secrets,
    __emit: (type: unknown, data: unknown) => {
      if (events.length >= 32) {
        throw new Error("Connector may emit at most 32 events");
      }
      const event = validateOutput({ type, data });
      emittedBytes += Buffer.byteLength(JSON.stringify(event));
      if (emittedBytes > MAX_YAML_LENGTH) {
        throw new Error("Connector emissions exceed the total size limit");
      }
      events.push(event);
    },
    __verifyBody: (body: unknown, signature: unknown) => {
      if (!Buffer.isBuffer(body) || typeof signature !== "string" || !secrets.WEBHOOK_SECRET) {
        return false;
      }
      const match = /^sha256=([a-fA-F0-9]{64})$/i.exec(signature);
      if (!match) {
        return false;
      }
      const supplied = Buffer.from(match[1], "hex");
      const expected = createHmac("sha256", secrets.WEBHOOK_SECRET).update(body).digest();
      return supplied.length === expected.length && timingSafeEqual(supplied, expected);
    },
    Buffer: {
      from: (value: unknown, encoding?: unknown) => {
        if (
          typeof value !== "string" ||
          value.length > MAX_YAML_LENGTH ||
          (encoding !== undefined && encoding !== "base64" && encoding !== "utf8" && encoding !== "hex")
        ) {
          throw new Error("Buffer.from accepts bounded text and a supported encoding");
        }
        const bytes = Buffer.from(value, (encoding ?? "utf8") as BufferEncoding);
        if (bytes.byteLength > MAX_YAML_LENGTH) {
          throw new Error("Buffer exceeds the size limit");
        }
        return bytes;
      },
    },
  };
  evaluateProgram(parseProgram(definition.run), env);
  return events;
}
