const MAX_SNAPSHOT_BYTES = 64 * 1024;
const SENSITIVE_KEY = /(?:secret|password|token|credential|authorization|private.?key)/i;

export type StepAttemptSnapshot = {
  version: 1;
  status: "captured" | "omitted";
  reason?: "too_large";
  inputs?: Record<string, unknown>;
  priorSteps?: Record<string, unknown>;
  outputs?: unknown;
};

function sanitize(value: unknown, depth = 0): unknown {
  if (depth > 16) {
    return "[DEPTH_LIMIT]";
  }
  if (typeof value === "string" || typeof value === "boolean" || value === null) {
    return value;
  }
  if (typeof value === "number") {
    return Number.isFinite(value) ? value : null;
  }
  if (Array.isArray(value)) {
    return value.slice(0, 1000).map((item) => sanitize(item, depth + 1));
  }
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value)
        .filter(([key]) => !SENSITIVE_KEY.test(key))
        .map(([key, item]) => [key, sanitize(item, depth + 1)]),
    );
  }
  return null;
}

/** Captures bounded, allowlisted workflow context without secrets or runtime/environment state. */
export function createStepAttemptSnapshot(input: {
  inputs: unknown;
  priorSteps: unknown;
  outputs: unknown;
  writeOnlyInputNames?: string[];
}): StepAttemptSnapshot {
  const safeInputs = sanitize(input.inputs);
  const safePriorSteps = sanitize(input.priorSteps);
  const safeOutputs = sanitize(input.outputs);
  if (safeInputs && typeof safeInputs === "object" && !Array.isArray(safeInputs)) {
    for (const name of input.writeOnlyInputNames || []) {
      delete (safeInputs as Record<string, unknown>)[name];
    }
  }
  const snapshot: StepAttemptSnapshot = {
    version: 1,
    status: "captured",
    inputs: (safeInputs || {}) as Record<string, unknown>,
    priorSteps: (safePriorSteps || {}) as Record<string, unknown>,
    outputs: safeOutputs,
  };
  if (Buffer.byteLength(JSON.stringify(snapshot), "utf8") > MAX_SNAPSHOT_BYTES) {
    return { version: 1, status: "omitted", reason: "too_large" };
  }
  return snapshot;
}
