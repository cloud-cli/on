import Ajv, { type ErrorObject, type ValidateFunction } from "ajv";

const ajv = new Ajv({ allErrors: true, jsonPointers: true, schemaId: "auto", meta: true });

const validators = new Map<string, ValidateFunction>();
const MAX_SCHEMA_BYTES = 64 * 1024;
const MAX_CACHED_SCHEMAS = 128;
const MAX_SCHEMA_NODES = 5_000;
const MAX_SCHEMA_DEPTH = 64;

function validatorFor(schema: Record<string, unknown>): ValidateFunction {
  const key = JSON.stringify(schema);
  const cached = validators.get(key);
  if (cached) {
    validators.delete(key);
    validators.set(key, cached);
    return cached;
  }
  const validator = ajv.compile(schema);
  if (validators.size >= MAX_CACHED_SCHEMAS) {
    const oldest = validators.keys().next().value;
    if (oldest) {
      validators.delete(oldest);
      ajv.removeSchema(JSON.parse(oldest));
    }
  }
  validators.set(key, validator);
  return validator;
}

function summarize(errors: ErrorObject[] | null | undefined, path: string): string {
  const error = errors?.[0];
  if (!error) {
    return `${path} does not match its JSON Schema`;
  }
  const instancePath = error.dataPath ? `${path}${error.dataPath}` : path;
  return `${instancePath} ${error.message || "is invalid"}`;
}

function assertSchemaComplexity(schema: unknown): void {
  const stack: Array<{ value: unknown; depth: number }> = [{ value: schema, depth: 0 }];
  const visited = new Set<object>();
  let nodes = 0;
  while (stack.length) {
    const current = stack.pop()!;
    if (!current.value || typeof current.value !== "object" || visited.has(current.value as object)) {
      continue;
    }
    visited.add(current.value as object);
    nodes += 1;
    if (nodes > MAX_SCHEMA_NODES) {
      throw new Error(`JSON Schema exceeds the ${MAX_SCHEMA_NODES} node limit`);
    }
    if (current.depth > MAX_SCHEMA_DEPTH) {
      throw new Error(`JSON Schema exceeds the ${MAX_SCHEMA_DEPTH} level nesting limit`);
    }
    for (const value of Object.values(current.value)) {
      stack.push({ value, depth: current.depth + 1 });
    }
  }
}

export function validateRecipeSchema(schema: unknown): asserts schema is Record<string, unknown> {
  if (!schema || typeof schema !== "object" || Array.isArray(schema)) {
    throw new Error("inputs must be a JSON Schema object");
  }
  try {
    const serialized = JSON.stringify(schema);
    if (Buffer.byteLength(serialized, "utf8") > MAX_SCHEMA_BYTES) {
      throw new Error(`JSON Schema exceeds the ${MAX_SCHEMA_BYTES} byte limit`);
    }
    assertSchemaComplexity(schema);
    const validate = validatorFor(schema as Record<string, unknown>);
    if (validate.errors) {
      throw new Error(summarize(validate.errors, "inputs"));
    }
  } catch (error) {
    throw new Error(`Invalid inputs JSON Schema: ${error instanceof Error ? error.message : String(error)}`);
  }
}

export function validateRecipeInputs(schema: Record<string, unknown>, value: unknown, path = "inputs"): void {
  let validate: ValidateFunction;
  try {
    validate = validatorFor(schema);
  } catch (error) {
    throw new Error(`Invalid inputs JSON Schema: ${error instanceof Error ? error.message : String(error)}`);
  }
  if (!validate(value)) {
    throw new Error(summarize(validate.errors, path));
  }
}

export function ordinaryRecipeInputSchema(schema: Record<string, unknown>): Record<string, unknown> {
  const properties = schema.properties;
  if (!properties || typeof properties !== "object" || Array.isArray(properties)) {
    return schema;
  }
  const regularProperties = Object.fromEntries(
    Object.entries(properties).filter(
      ([, definition]) => !(definition && typeof definition === "object" && (definition as any).writeOnly === true),
    ),
  );
  const regularRequired = Array.isArray(schema.required)
    ? schema.required.filter((key) => !(properties as Record<string, any>)[String(key)]?.writeOnly)
    : schema.required;
  return { ...schema, properties: regularProperties, required: regularRequired };
}
