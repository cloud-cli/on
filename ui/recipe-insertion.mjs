import { parseDocument, isAlias, YAMLMap } from "yaml";

export function matchesRecipeSearch(recipe, query) {
  const needle = String(query || "")
    .trim()
    .toLowerCase();
  return (
    !needle ||
    [recipe.name, recipe.namespace, recipe.slug].some((value) =>
      String(value || "")
        .toLowerCase()
        .includes(needle),
    )
  );
}

export function canInsertRecipe(recipe) {
  return Boolean(recipe && !recipe.revoked);
}

export function commitRecipeInsertion(currentSource, originalSource, plan, confirmed) {
  if (currentSource !== originalSource) {
    return { inserted: false, reason: "The workflow changed since opening this picker." };
  }
  if (!plan?.safe) {
    return { inserted: false, reason: plan?.reason || "This YAML cannot be safely changed." };
  }
  if (plan.replacesSteps && !confirmed) {
    return { inserted: false, needsConfirmation: true };
  }
  return { inserted: true, source: plan.source };
}

export function prepareRecipeInsertion(source, reference) {
  const snippet = `using: ${reference}\nwith: {}\nsecrets: {}`;
  const doc = parseDocument(source, { uniqueKeys: true });
  if (doc.errors.length || doc.warnings.length) {
    return { safe: false, snippet, reason: "Workflow YAML is malformed or ambiguous." };
  }
  const contents = doc.contents;
  if (!contents) {
    if (source.trim()) {
      return { safe: false, snippet, reason: "Workflow YAML cannot be safely parsed." };
    }
    return { safe: true, source: `${snippet}\n`, snippet, replacesSteps: false };
  }
  if (!(contents instanceof YAMLMap) || contents.items.some((pair) => isAlias(pair.key) || isAlias(pair.value))) {
    return {
      safe: false,
      snippet,
      reason: "Root-level YAML aliases or non-mapping content are not supported for automatic insertion.",
    };
  }
  const keys = new Map();
  for (const pair of contents.items) {
    if (typeof pair.key?.value !== "string") {
      return { safe: false, snippet, reason: "Workflow root keys are ambiguous." };
    }
    keys.set(pair.key.value, pair);
  }
  const stepPair = keys.get("steps");
  if (!stepPair || ["using", "with", "secrets"].some((key) => keys.has(key))) {
    return {
      safe: false,
      snippet,
      reason: "Automatic insertion requires one root-level steps key and no colliding recipe keys.",
    };
  }
  const start = stepPair.key.range?.[0];
  const end = stepPair.value?.range?.[1];
  if (!Number.isInteger(start) || !Number.isInteger(end)) {
    return { safe: false, snippet, reason: "The root steps section could not be safely located." };
  }
  const block = source.slice(start, end);
  if (/(^|\n)\s*#/.test(source) || /(^|\s)[&*][A-Za-z0-9_-]+/.test(source) || /(^|\n)\s*#/.test(block)) {
    return { safe: false, snippet, reason: "Comments or aliases make automatic replacement ambiguous." };
  }
  const suffix = source.slice(end);
  return {
    safe: true,
    source: `${source.slice(0, start)}${snippet}${suffix && !suffix.startsWith("\n") ? "\n" : ""}${suffix}`,
    snippet,
    replacesSteps: true,
  };
}
