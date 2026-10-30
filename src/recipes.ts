import YAML from "yaml";
import crypto from "node:crypto";
import db from "./db-client.js";
import { DEFAULT_STEP_TIMEOUT_MS } from "./workflow-constants.js";
import { validateRecipeSchema, validateRecipeInputs } from "./recipe-schema.js";

const BUILT_IN_RECIPE_OWNER = "system:built-in-recipes";
const DOCKER_BUILD_RECIPE = `inputs:
  image: { type: string, required: true }
  imageTag: { type: string, default: latest }
  registryUsername: { type: string, required: true }
  cloneUrl: { type: string, required: true }
  commitSha: { type: string, required: true }
secrets:
  githubToken: { type: string, required: true }
env:
  IMAGE: "\${inputs.image}"
  IMAGE_TAG: "\${inputs.imageTag}"
  REGISTRY_USERNAME: "\${inputs.registryUsername}"
  CLONE_URL: "\${inputs.cloneUrl}"
  COMMIT_SHA: "\${inputs.commitSha}"
  GITHUB_TOKEN: "\${secrets.githubToken}"
steps:
  - run: |
      set -euo pipefail
      git clone --no-checkout "$CLONE_URL" source
      cd source
      git checkout --detach "$COMMIT_SHA"
  - run: |
      set -euo pipefail
      printf '%s' "$GITHUB_TOKEN" | docker login ghcr.io -u "$REGISTRY_USERNAME" --password-stdin
  - run: |
      set -euo pipefail
      cd source
      docker build --label "org.opencontainers.image.revision=$COMMIT_SHA" -t "$IMAGE:$IMAGE_TAG" .
  - run: |
      set -euo pipefail
      docker push "$IMAGE:$IMAGE_TAG"
  - run: |
      set -euo pipefail
      IMAGE_TAG="$IMAGE:$IMAGE_TAG"
      services="$(cy dx.list --image "$IMAGE_TAG" | jq -r '.[].name')"
      if [ -z "$services" ]; then
        echo "No services match image $IMAGE_TAG; image published without restarting services."
        exit 0
      fi
      while IFS= read -r service; do
        [ -n "$service" ] || continue
        cy dx.pull "$service"
        cy dx.restart "$service"
      done <<< "$services"
`;

export { validateRecipeInputs, ordinaryRecipeInputSchema } from "./recipe-schema.js";

export type Recipe = {
  namespace: string;
  slug: string;
  version: number;
  name: string;
  sourceYaml: string;
  inputs: Record<string, unknown>;
  env: Record<string, unknown>;
  steps: unknown[];
  functions: Record<string, RecipeFunction>;
  revoked: boolean;
};

export type RecipeCallStep = {
  id: string;
  call: string;
  with: Record<string, unknown>;
  secrets?: Record<string, string>;
};
export type SecretDeclaration = { type: "string" | "file"; required?: boolean };
export type RecipeFunction = {
  inputs: Record<string, unknown>;
  secrets?: Record<string, SecretDeclaration>;
  outputs: Record<string, unknown>;
  returns?: Record<string, string>;
  steps: unknown[];
};
export type ParsedRecipe = {
  name: string;
  inputs: Record<string, unknown>;
  env: Record<string, unknown>;
  steps: unknown[];
  functions: Record<string, RecipeFunction>;
};

function inputSchema(value: unknown): Record<string, unknown> {
  if (value === undefined) {
    return { type: "object", properties: {} };
  }
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("Recipe inputs must be a map");
  }
  // Accept the former JSON-Schema representation while existing stored recipes are being migrated.
  if ((value as any).type === "object") {
    return value as Record<string, unknown>;
  }
  const properties: Record<string, unknown> = {};
  const required: string[] = [];
  for (const [name, declaration] of Object.entries(value)) {
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(name)) {
      throw new Error(`Recipe input name "${name}" must be a valid identifier`);
    }
    if (!declaration || typeof declaration !== "object" || Array.isArray(declaration) || !(declaration as any).type) {
      throw new Error(`Recipe input "${name}" must declare a type`);
    }
    const { required: isRequired, ...schema } = declaration as any;
    if (isRequired !== undefined && typeof isRequired !== "boolean") {
      throw new Error(`Recipe input "${name}" required must be boolean`);
    }
    properties[name] = schema;
    if (isRequired) {
      required.push(name);
    }
  }
  return {
    type: "object",
    properties,
    ...(required.length ? { required } : {}),
  };
}

function secretSchema(value: unknown): Record<string, SecretDeclaration> {
  if (value === undefined) {
    return {};
  }
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("Recipe secrets must be a map");
  }
  const result: Record<string, SecretDeclaration> = {};
  for (const [name, declaration] of Object.entries(value)) {
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(name)) {
      throw new Error(`Recipe secret name "${name}" must be a valid identifier`);
    }
    const type = typeof declaration === "string" ? declaration : (declaration as any)?.type;
    const required =
      typeof declaration === "object" && declaration !== null ? (declaration as any).required : undefined;
    if (
      !["string", "file"].includes(type) ||
      (required !== undefined && typeof required !== "boolean") ||
      (typeof declaration === "object" &&
        Object.keys(declaration as object).some((key) => !["type", "required"].includes(key)))
    ) {
      throw new Error(`Recipe secret "${name}" must declare type string or file and optional required boolean`);
    }
    result[name] = { type, ...(required === undefined ? {} : { required }) };
  }
  return result;
}

export function isSafeRecipeExpression(value: unknown): value is string {
  return typeof value === "string" && /^\$\{(?:inputs|steps|job|matrix)(?:\.[A-Za-z_][A-Za-z0-9_-]*)+\}$/.test(value);
}

export function parseRecipe(sourceYaml: string): ParsedRecipe {
  const doc = YAML.parse(sourceYaml);
  if (!doc || typeof doc !== "object" || Array.isArray(doc)) {
    throw new Error("Recipe must be a YAML object");
  }
  if (Object.keys(doc).some((key) => !["inputs", "secrets", "env", "steps", "functions"].includes(key))) {
    throw new Error("Recipe may contain only inputs, secrets, env, steps, and functions");
  }
  const legacy = Object.hasOwn(doc, "inputs") || Object.hasOwn(doc, "secrets") || Object.hasOwn(doc, "steps");
  if (legacy && Object.hasOwn(doc, "functions")) {
    throw new Error("Recipe must use either top-level inputs/steps or functions, not both");
  }
  const functionDefinitions: Record<string, any> = legacy
    ? {
        main: {
          inputs: inputSchema(doc.inputs),
          secrets: secretSchema(doc.secrets),
          outputs: { type: "object" },
          steps: doc.steps,
        },
      }
    : doc.functions;
  if (
    !functionDefinitions ||
    typeof functionDefinitions !== "object" ||
    Array.isArray(functionDefinitions) ||
    !Object.keys(functionDefinitions).length
  ) {
    throw new Error("Recipe requires at least one function");
  }
  const functions: Record<string, RecipeFunction> = {};
  for (const [functionName, definition] of Object.entries(functionDefinitions)) {
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(functionName)) {
      throw new Error(`Recipe function name "${functionName}" must be a valid identifier`);
    }
    if (
      !definition ||
      typeof definition !== "object" ||
      Array.isArray(definition) ||
      Object.keys(definition).some((key) => !["inputs", "secrets", "outputs", "returns", "steps"].includes(key))
    ) {
      throw new Error(`Recipe function "${functionName}" must contain inputs, outputs, and steps`);
    }
    const docInputs = (definition as any).inputs;
    const outputs = (definition as any).outputs;
    const secrets = secretSchema((definition as any).secrets);
    const returns = (definition as any).returns;
    const steps = (definition as any).steps;
    if (!docInputs || typeof docInputs !== "object" || Array.isArray(docInputs)) {
      throw new Error("Recipe inputs must be a JSON Schema object");
    }
    validateRecipeSchema(docInputs);
    if (docInputs.type !== "object") {
      throw new Error("Recipe inputs schema must declare type: object");
    }
    for (const [name, definition] of Object.entries((docInputs as any).properties || {})) {
      if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(name)) {
        throw new Error(`Recipe input name "${name}" must be a valid identifier`);
      }
      if ((definition as any)?.writeOnly === true && (definition as any)?.type !== "string") {
        throw new Error(`Secret recipe input "${name}" must have type: string`);
      }
    }
    if (!outputs || typeof outputs !== "object" || Array.isArray(outputs)) {
      throw new Error(`Recipe function "${functionName}" outputs must be a JSON Schema object`);
    }
    validateRecipeSchema(outputs);
    if (outputs.type !== "object") {
      throw new Error(`Recipe function "${functionName}" outputs schema must declare type: object`);
    }
    if (returns !== undefined) {
      const properties = outputs.properties || {};
      if (!returns || typeof returns !== "object" || Array.isArray(returns)) {
        throw new Error(`Recipe function "${functionName}" returns must be an object of output expressions`);
      }
      for (const [name, expression] of Object.entries(returns)) {
        if (!Object.hasOwn(properties, name) || !isSafeRecipeExpression(expression)) {
          throw new Error(
            `Recipe function "${functionName}" returns.${name} must map a declared output to a supported expression`,
          );
        }
      }
    }
    const requiredOutputs = Array.isArray(outputs.required) ? (outputs.required as string[]) : [];
    for (const name of requiredOutputs) {
      if (returns === undefined || !Object.hasOwn(returns, name)) {
        throw new Error(`Recipe function "${functionName}" must return required output: ${name}`);
      }
    }
    if (!Array.isArray(steps) || !steps.length) {
      throw new Error("Recipe requires at least one step");
    }
    for (const [index, step] of steps.entries()) {
      if (!step || typeof step !== "object" || Array.isArray(step)) {
        throw new Error(`functions.${functionName}.steps[${index}] must be an object`);
      }
      if ("using" in step) {
        throw new Error("Nested recipe references must use the call target field");
      }
      if ("call" in step) {
        if (Object.keys(step).some((key) => !["id", "call", "with", "secrets", "name", "if"].includes(key))) {
          throw new Error(`functions.${functionName}.steps[${index}] has unsupported call fields`);
        }
        if (typeof step.id !== "string" || !/^[A-Za-z_][A-Za-z0-9_-]*$/.test(step.id)) {
          throw new Error(`functions.${functionName}.steps[${index}] nested call requires a stable id`);
        }
        if (
          typeof step.call !== "string" ||
          !/^[a-z0-9][a-z0-9-]{0,62}\/[a-z0-9][a-z0-9-]{0,62}@[1-9][0-9]*#[A-Za-z_][A-Za-z0-9_]*$/.test(step.call)
        ) {
          throw new Error(
            `functions.${functionName}.steps[${index}].call must be namespace/slug@<integer-version>#<function-name>`,
          );
        }
        if (!step.with || typeof step.with !== "object" || Array.isArray(step.with)) {
          throw new Error(`functions.${functionName}.steps[${index}].with must be an object`);
        }
        if (
          step.secrets !== undefined &&
          (!step.secrets || typeof step.secrets !== "object" || Array.isArray(step.secrets))
        ) {
          throw new Error(`functions.${functionName}.steps[${index}].secrets must be an object`);
        }
        continue;
      }
      if ("secrets" in step) {
        throw new Error("Secrets are valid only for nested calls");
      }
      const timeoutMs = (step as any).timeoutMs ?? DEFAULT_STEP_TIMEOUT_MS;
      if (!Number.isInteger(timeoutMs) || timeoutMs <= 0) {
        throw new Error(`functions.${functionName}.steps[${index}].timeoutMs must be a positive integer`);
      }
    }
    functions[functionName] = {
      inputs: docInputs,
      ...(Object.keys(secrets).length ? { secrets } : {}),
      outputs,
      ...(returns ? { returns } : {}),
      steps,
    };
  }

  if (doc.env !== undefined && (!doc.env || typeof doc.env !== "object" || Array.isArray(doc.env))) {
    throw new Error("Recipe env must be an object");
  }
  const env = doc.env || {};
  for (const [name, value] of Object.entries(env)) {
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(name) || typeof value !== "string") {
      throw new Error(`Recipe env.${name} must be a string value with a valid environment variable name`);
    }
  }
  return {
    name: "",
    inputs: legacy ? functions.main.inputs : functions[Object.keys(functions)[0]].inputs,
    env,
    steps: legacy ? doc.steps : functions[Object.keys(functions)[0]].steps,
    functions,
  };
}

export class RecipeRepository {
  async init(): Promise<void> {
    await db.exec(`CREATE TABLE IF NOT EXISTS recipes (
      namespace TEXT NOT NULL, slug TEXT NOT NULL, owner_subject TEXT NOT NULL,
      PRIMARY KEY(namespace, slug)
    );
    CREATE TABLE IF NOT EXISTS recipe_publishers (
      owner_subject TEXT PRIMARY KEY, namespace TEXT NOT NULL UNIQUE
    );
    CREATE TABLE IF NOT EXISTS recipe_versions (
      namespace TEXT NOT NULL, slug TEXT NOT NULL, version INTEGER NOT NULL, name TEXT NOT NULL, publish_id TEXT UNIQUE,
      source_yaml TEXT NOT NULL, inputs_json TEXT NOT NULL, steps_json TEXT NOT NULL,
      functions_json TEXT, env_json TEXT NOT NULL DEFAULT '{}',
      revoked INTEGER NOT NULL DEFAULT 0, created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      PRIMARY KEY(namespace, slug, version),
      FOREIGN KEY(namespace, slug) REFERENCES recipes(namespace, slug)
    );`);
    const columns = await db.all("PRAGMA table_info(recipe_versions)");
    if (!columns.some((column: any) => column.name === "functions_json")) {
      await db.exec("ALTER TABLE recipe_versions ADD COLUMN functions_json TEXT");
    }
    if (!columns.some((column: any) => column.name === "env_json")) {
      await db.exec("ALTER TABLE recipe_versions ADD COLUMN env_json TEXT NOT NULL DEFAULT '{}'");
    }
    if (!columns.some((column: any) => column.name === "publish_id")) {
      await db.exec("ALTER TABLE recipe_versions ADD COLUMN publish_id TEXT");
      await db.exec("CREATE UNIQUE INDEX IF NOT EXISTS recipe_versions_publish_id ON recipe_versions(publish_id)");
    }
    await this.seedBuiltInRecipes();
  }

  private async seedBuiltInRecipes(): Promise<void> {
    await db.run(
      "INSERT INTO recipe_publishers(owner_subject,namespace) VALUES(?,?) ON CONFLICT(owner_subject) DO NOTHING",
      [BUILT_IN_RECIPE_OWNER, "on"],
    );
    const publisher = await db.get("SELECT owner_subject FROM recipe_publishers WHERE namespace=?", ["on"]);
    if (publisher?.owner_subject !== BUILT_IN_RECIPE_OWNER) {
      throw new Error('Built-in recipe namespace "on" is owned by another publisher');
    }
    await db.run(
      "INSERT INTO recipes(namespace,slug,owner_subject) VALUES(?,?,?) ON CONFLICT(namespace,slug) DO NOTHING",
      ["on", "docker-build", BUILT_IN_RECIPE_OWNER],
    );
    const recipe = await db.get("SELECT owner_subject FROM recipes WHERE namespace=? AND slug=?", [
      "on",
      "docker-build",
    ]);
    if (recipe?.owner_subject !== BUILT_IN_RECIPE_OWNER) {
      throw new Error('Built-in recipe "on/docker-build" is owned by another publisher');
    }
    await db.run(
      "INSERT INTO recipe_versions(namespace,slug,version,name,source_yaml,inputs_json,steps_json,functions_json,env_json) SELECT ?,?,?,?, ?,?,?,?,? WHERE NOT EXISTS (SELECT 1 FROM recipe_versions WHERE namespace=? AND slug=? AND version=?)",
      [
        "on",
        "docker-build",
        1,
        "Docker Build",
        DOCKER_BUILD_RECIPE,
        JSON.stringify(parseRecipe(DOCKER_BUILD_RECIPE).inputs),
        JSON.stringify(parseRecipe(DOCKER_BUILD_RECIPE).steps),
        JSON.stringify(parseRecipe(DOCKER_BUILD_RECIPE).functions),
        JSON.stringify(parseRecipe(DOCKER_BUILD_RECIPE).env),
        "on",
        "docker-build",
        1,
      ],
    );
  }

  async list(): Promise<Recipe[]> {
    return (
      await db.all(`SELECT namespace,slug,version,name,source_yaml,inputs_json,steps_json,functions_json,env_json,revoked FROM recipe_versions
      WHERE version = (SELECT MAX(v.version) FROM recipe_versions v WHERE v.namespace=recipe_versions.namespace AND v.slug=recipe_versions.slug)
      ORDER BY namespace,slug`)
    ).map((row: any) => this.fromRow(row));
  }

  async get(namespace: string, slug: string, version: number): Promise<Recipe | null> {
    const row = await db.get("SELECT * FROM recipe_versions WHERE namespace=? AND slug=? AND version=?", [
      namespace,
      slug,
      version,
    ]);
    return row ? this.fromRow(row) : null;
  }

  async namespaceForOwner(slug: string, ownerSubject: string): Promise<string | null> {
    const row = await db.get(
      "SELECT namespace FROM recipes WHERE slug=? AND owner_subject=? ORDER BY namespace LIMIT 1",
      [slug, ownerSubject],
    );
    return typeof row?.namespace === "string" ? row.namespace : null;
  }

  async getOrCreateNamespace(ownerSubject: string, preferredUsername: string): Promise<string> {
    const current = await db.get("SELECT namespace FROM recipe_publishers WHERE owner_subject=?", [ownerSubject]);
    if (current?.namespace) {
      return current.namespace;
    }
    const namespace = preferredUsername
      .trim()
      .toLowerCase()
      .replace(/[^a-z0-9-]+/g, "-")
      .replace(/^-+|-+$/g, "");
    if (!/^[a-z0-9][a-z0-9-]{0,62}$/.test(namespace)) {
      throw new Error("OIDC preferred_username is required to publish a recipe");
    }
    await db.run(
      "INSERT INTO recipe_publishers(owner_subject,namespace) VALUES(?,?) ON CONFLICT(owner_subject) DO NOTHING",
      [ownerSubject, namespace],
    );
    const persisted = await db.get("SELECT namespace FROM recipe_publishers WHERE owner_subject=?", [ownerSubject]);
    if (!persisted?.namespace) {
      throw new Error("That recipe namespace is already owned");
    }
    return persisted.namespace;
  }

  async publish(
    namespace: string,
    slug: string,
    name: string,
    ownerSubject: string,
    sourceYaml: string,
  ): Promise<Recipe> {
    if (!/^[a-z0-9][a-z0-9-]{0,62}$/.test(namespace) || !/^[a-z0-9][a-z0-9-]{0,62}$/.test(slug)) {
      throw new Error("Invalid recipe namespace or slug");
    }
    const parsed = parseRecipe(sourceYaml);
    if (!name.trim()) {
      throw new Error("Recipe name is required in registry metadata");
    }
    if (typeof db.transaction !== "function") {
      throw new Error("Publishing recipes requires database transactions");
    }
    const publishId = crypto.randomUUID();
    let version = 0;
    await db.transaction([
      {
        s: "INSERT INTO recipes(namespace,slug,owner_subject) SELECT ?,?,? WHERE EXISTS (SELECT 1 FROM recipe_publishers WHERE owner_subject=? AND namespace=?) ON CONFLICT(namespace,slug) DO NOTHING",
        d: [namespace, slug, ownerSubject, ownerSubject, namespace],
        m: "run",
      },
      {
        s: "INSERT INTO recipe_versions(namespace,slug,version,name,publish_id,source_yaml,inputs_json,steps_json,functions_json,env_json) SELECT ?,?,COALESCE((SELECT MAX(version) FROM recipe_versions WHERE namespace=? AND slug=?),0)+1,?,?,?,?,?,?,? WHERE EXISTS (SELECT 1 FROM recipes WHERE namespace=? AND slug=? AND owner_subject=?)",
        d: [
          namespace,
          slug,
          namespace,
          slug,
          name.trim(),
          publishId,
          sourceYaml,
          JSON.stringify(parsed.inputs),
          JSON.stringify(parsed.steps),
          JSON.stringify(parsed.functions),
          JSON.stringify(parsed.env),
          namespace,
          slug,
          ownerSubject,
        ],
        m: "run",
      },
    ]);
    const published = await db.get("SELECT version FROM recipe_versions WHERE publish_id=?", [publishId]);
    version = Number(published?.version);
    if (!version) {
      throw new Error("Recipe could not be published for this owner");
    }
    const owned = await db.get("SELECT owner_subject FROM recipes WHERE namespace=? AND slug=?", [namespace, slug]);
    if (!owned || owned.owner_subject !== ownerSubject) {
      throw new Error("Recipe namespace is owned by another publisher");
    }
    return {
      namespace,
      slug,
      version,
      ...parsed,
      name: name.trim(),
      sourceYaml,
      revoked: false,
    };
  }

  async revoke(namespace: string, slug: string, version: number): Promise<boolean> {
    const result = await db.run("UPDATE recipe_versions SET revoked=1 WHERE namespace=? AND slug=? AND version=?", [
      namespace,
      slug,
      version,
    ]);
    return Number(result?.changes || 0) === 1;
  }

  private fromRow(row: any): Recipe {
    return {
      namespace: row.namespace,
      slug: row.slug,
      version: Number(row.version),
      name: row.name,
      sourceYaml: row.source_yaml,
      inputs: JSON.parse(row.inputs_json),
      env: row.env_json ? JSON.parse(row.env_json) : {},
      steps: JSON.parse(row.steps_json),
      functions: row.functions_json
        ? JSON.parse(row.functions_json)
        : {
            main: {
              inputs: JSON.parse(row.inputs_json),
              outputs: { type: "object" },
              steps: JSON.parse(row.steps_json),
            },
          },
      revoked: Boolean(row.revoked),
    };
  }
}
