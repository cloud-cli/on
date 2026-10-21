import YAML from "yaml";
import crypto from "node:crypto";
import db from "./db-client.js";
import { DEFAULT_STEP_TIMEOUT_MS } from "./workflow-constants.js";
import { validateRecipeSchema, validateRecipeInputs } from "./recipe-schema.js";

export { validateRecipeInputs, ordinaryRecipeInputSchema } from "./recipe-schema.js";

export type Recipe = {
  namespace: string;
  slug: string;
  version: number;
  name: string;
  sourceYaml: string;
  inputs: Record<string, unknown>;
  steps: unknown[];
  revoked: boolean;
};

export function parseRecipe(sourceYaml: string): { name: string; inputs: Record<string, unknown>; steps: unknown[] } {
  const doc = YAML.parse(sourceYaml);
  if (!doc || typeof doc !== "object" || Array.isArray(doc)) {
    throw new Error("Recipe must be a YAML object");
  }
  if (Object.keys(doc).some((key) => !["inputs", "steps"].includes(key))) {
    throw new Error("Recipe may contain only inputs and steps");
  }
  if (!doc.inputs || typeof doc.inputs !== "object" || Array.isArray(doc.inputs)) {
    throw new Error("Recipe inputs must be a JSON Schema object");
  }
  validateRecipeSchema(doc.inputs);
  if (doc.inputs.type !== "object") {
    throw new Error("Recipe inputs schema must declare type: object");
  }
  for (const [name, definition] of Object.entries((doc.inputs as any).properties || {})) {
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(name)) {
      throw new Error(`Recipe input name "${name}" must be a valid identifier`);
    }
    if ((definition as any)?.writeOnly === true && (definition as any)?.type !== "string") {
      throw new Error(`Secret recipe input "${name}" must have type: string`);
    }
  }
  if (!Array.isArray(doc.steps) || !doc.steps.length) {
    throw new Error("Recipe requires at least one step");
  }
  for (const [index, step] of doc.steps.entries()) {
    if (!step || typeof step !== "object" || Array.isArray(step)) {
      throw new Error(`steps[${index}] must be an object`);
    }
    if ("using" in step || "secrets" in step) {
      throw new Error("Nested recipe references are not supported");
    }
    const timeoutMs = (step as any).timeoutMs ?? DEFAULT_STEP_TIMEOUT_MS;
    if (!Number.isInteger(timeoutMs) || timeoutMs <= 0) {
      throw new Error(`steps[${index}].timeoutMs must be a positive integer`);
    }
  }
  return { name: "", inputs: doc.inputs, steps: doc.steps };
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
      revoked INTEGER NOT NULL DEFAULT 0, created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      PRIMARY KEY(namespace, slug, version),
      FOREIGN KEY(namespace, slug) REFERENCES recipes(namespace, slug)
    );`);
    const columns = await db.all("PRAGMA table_info(recipe_versions)");
    if (!columns.some((column: any) => column.name === "publish_id")) {
      await db.exec("ALTER TABLE recipe_versions ADD COLUMN publish_id TEXT");
      await db.exec("CREATE UNIQUE INDEX IF NOT EXISTS recipe_versions_publish_id ON recipe_versions(publish_id)");
    }
  }

  async list(): Promise<Recipe[]> {
    return (
      await db.all(`SELECT namespace,slug,version,name,source_yaml,inputs_json,steps_json,revoked FROM recipe_versions
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
        s: "INSERT INTO recipe_versions(namespace,slug,version,name,publish_id,source_yaml,inputs_json,steps_json) SELECT ?,?,COALESCE((SELECT MAX(version) FROM recipe_versions WHERE namespace=? AND slug=?),0)+1,?,?,?,?,? WHERE EXISTS (SELECT 1 FROM recipes WHERE namespace=? AND slug=? AND owner_subject=?)",
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
    return { namespace, slug, version, ...parsed, name: name.trim(), sourceYaml, revoked: false };
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
      steps: JSON.parse(row.steps_json),
      revoked: Boolean(row.revoked),
    };
  }
}
