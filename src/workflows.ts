import YAML from "yaml";
import db from "./db-client.js";
import { runMigrations } from "./migrations.js";
import type { WorkflowDefinition, WorkflowRevision } from "./types.js";
import { ensureTeamDataSchema } from "./team-data-schema.js";
import { DEFAULT_STEP_TIMEOUT_MS } from "./workflow-constants.js";
import {
  Recipe,
  RecipeRepository,
  isSafeRecipeExpression,
  validateRecipeInputs,
  ordinaryRecipeInputSchema,
} from "./recipes.js";

export { DEFAULT_STEP_TIMEOUT_MS } from "./workflow-constants.js";

export interface StoredWorkflow {
  id: string;
  name: string;
  sourceYaml: string;
  revision: number;
  status: "draft" | "published" | "archived";
  enabled: boolean;
}

function workflowId(value: unknown): string {
  if (typeof value !== "string" || !value.trim()) {
    throw new Error("Workflow id is required");
  }
  const id = value
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
  if (!id || id.length > 128) {
    throw new Error("Workflow id must contain 1 to 128 letters, numbers, or hyphens");
  }
  return id;
}

/** Parses the portable, DB-stored YAML format. Includes are deliberately unsupported. */
export function parseWorkflow(sourceYaml: string): WorkflowDefinition[] {
  const parsed = YAML.parse(sourceYaml);
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error("Workflow must be a YAML object");
  }
  if (parsed.includes) {
    throw new Error("includes is not supported for database workflows");
  }
  if (parsed.id === undefined || parsed.id === null || parsed.id === "") {
    throw new Error("Workflow id is required");
  }
  const canonicalId = workflowId(parsed.id);
  if (typeof parsed.name !== "string" || !parsed.name.trim()) {
    throw new Error("Workflow name is required");
  }
  if (!Array.isArray(parsed.steps) || !parsed.steps.length) {
    throw new Error("Workflow requires at least one step");
  }
  if (!parsed.on || typeof parsed.on !== "object") {
    throw new Error("Workflow requires an on block");
  }

  const eventTypes = parsed.on.events === undefined ? [] : parsed.on.events;
  if (
    !Array.isArray(eventTypes) ||
    eventTypes.some((type: unknown) => typeof type !== "string" || !/^[a-z][a-z0-9]*(?:[._-][a-z0-9]+)*$/.test(type)) ||
    new Set(eventTypes).size !== eventTypes.length
  ) {
    throw new Error("on.events must contain unique event type names (for example presence.arrived)");
  }

  const webhook = Object.entries(parsed.on).find(([name]) => !["schedule", "solar", "events"].includes(name));
  const [provider, trigger] = webhook || [eventTypes.length ? "domain-event" : "generic", {}];
  if (parsed.retries !== undefined && (!Number.isInteger(parsed.retries) || parsed.retries < 0)) {
    throw new Error("retries must be a non-negative integer");
  }
  const parseSteps = (stepList: any[], label: string) =>
    stepList.map((step: any) => {
      const timeoutMs = step.timeoutMs ?? DEFAULT_STEP_TIMEOUT_MS;
      if (!Number.isInteger(timeoutMs) || timeoutMs <= 0) {
        throw new Error(`${label}.timeoutMs must be a positive integer`);
      }
      const volumes =
        step.volumes === undefined ? undefined : Array.isArray(step.volumes) ? step.volumes : [step.volumes];
      const dockerArgs =
        step.dockerArgs === undefined
          ? undefined
          : Array.isArray(step.dockerArgs)
            ? step.dockerArgs
            : [step.dockerArgs];
      if (volumes?.some((volume: unknown) => typeof volume !== "string" || !volume.trim())) {
        throw new Error(`${label}.volumes must contain non-empty strings`);
      }
      if (dockerArgs?.some((arg: unknown) => typeof arg !== "string")) {
        throw new Error(`${label}.dockerArgs must contain strings`);
      }
      const { __recipeTemplate: _ignoredRecipeMarker, ...workflowStep } = step;
      return { ...workflowStep, timeoutMs, volumes, dockerArgs };
    });
  if (parsed.post !== undefined && !Array.isArray(parsed.post)) {
    throw new Error("Workflow post must be an array of steps");
  }
  const steps = parseSteps(parsed.steps, "step");
  const post = parseSteps(parsed.post || [], "post step");
  const stepIds = new Set<string>();
  for (const [index, step] of [...steps, ...post].entries()) {
    const id = step.id || `step-${index}`;
    if (stepIds.has(id)) {
      throw new Error("Workflow step IDs must be unique across steps and post steps");
    }
    stepIds.add(id);
  }
  const artifacts =
    parsed.artifacts === undefined
      ? undefined
      : {
          paths: Array.isArray(parsed.artifacts.paths) ? parsed.artifacts.paths : [],
        };
  const cache =
    parsed.cache === undefined
      ? undefined
      : {
          key: parsed.cache.key,
          paths: Array.isArray(parsed.cache.paths) ? parsed.cache.paths : [],
        };
  if (artifacts && artifacts.paths.some((path: unknown) => typeof path !== "string" || !path.trim())) {
    throw new Error("artifacts.paths must contain non-empty strings");
  }
  if (
    cache &&
    (typeof cache.key !== "string" ||
      !cache.key.trim() ||
      cache.paths.some((path: unknown) => typeof path !== "string" || !path.trim()))
  ) {
    throw new Error("cache requires a non-empty key and paths");
  }

  return [
    {
      id: canonicalId,
      name: parsed.name,
      matrix: parsed.matrix,
      on: { ...(trigger as object), provider },
      schedule: Array.isArray(parsed.on.schedule) ? parsed.on.schedule : undefined,
      solar: Array.isArray(parsed.on.solar) ? parsed.on.solar : undefined,
      eventTypes,
      concurrency: parsed.concurrency,
      steps,
      post,
      retries: parsed.retries ?? 0,
      env: parsed.env,
      artifacts,
      cache,
      secretFiles: parsed.secretFiles,
      plugins: Array.isArray(parsed.plugins) ? parsed.plugins : undefined,
      tags: Array.isArray(parsed.tags)
        ? [
            ...new Set(
              (parsed.tags as unknown[])
                .filter((tag): tag is string => typeof tag === "string")
                .map((tag) => tag.trim())
                .filter(Boolean),
            ),
          ]
        : undefined,
    },
  ];
}

export class WorkflowRepository {
  private recipes = new RecipeRepository();
  async init(): Promise<void> {
    await db.exec(`
      CREATE TABLE IF NOT EXISTS workflows (
        id TEXT PRIMARY KEY, definition_id TEXT, name TEXT NOT NULL, source_yaml TEXT NOT NULL,
        status TEXT NOT NULL DEFAULT 'draft', active_revision INTEGER, enabled INTEGER NOT NULL DEFAULT 1,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP, updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        team_id TEXT NOT NULL,
        FOREIGN KEY (team_id) REFERENCES teams(id) ON DELETE RESTRICT
      );
      CREATE TABLE IF NOT EXISTS workflow_revisions (
        workflow_id TEXT NOT NULL, revision INTEGER NOT NULL, source_yaml TEXT NOT NULL,
        normalized_json TEXT NOT NULL, created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        PRIMARY KEY (workflow_id, revision)
      );
      CREATE TABLE IF NOT EXISTS scheduled_runs (
        workflow_id TEXT NOT NULL, trigger_id TEXT NOT NULL, scheduled_for TEXT NOT NULL,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        PRIMARY KEY (workflow_id, trigger_id, scheduled_for)
      );
    `);
    await runMigrations();
    await ensureTeamDataSchema();
  }

  validate(sourceYaml: string): WorkflowDefinition[] {
    const workflows = parseWorkflow(sourceYaml);
    for (const workflow of workflows) {
      for (const schedule of workflow.schedule || []) {
        if (typeof schedule.cron !== "string" || schedule.cron.trim().split(/\s+/).length !== 5) {
          throw new Error("schedule.cron must have five fields");
        }
      }
      for (const solar of workflow.solar || []) {
        if (!solar.event || !Number.isFinite(solar.latitude) || !Number.isFinite(solar.longitude)) {
          throw new Error("solar triggers require event, latitude, and longitude");
        }
      }
    }
    return workflows;
  }

  private async resolveRecipeWorkflow(sourceYaml: string): Promise<{
    workflows: WorkflowDefinition[];
    recipeRef?: { namespace: string; slug: string; version: number };
    recipeInputs?: Record<string, unknown>;
    recipeInputSchema?: Record<string, unknown>;
    recipeSecrets?: Record<string, string>;
    recipeFunction?: string;
    recipeOutputs?: Record<string, unknown>;
    _pinnedRecipeFunctions?: Record<
      string,
      {
        inputs: Record<string, unknown>;
        outputs: Record<string, unknown>;
        returns?: Record<string, string>;
        steps: any[];
      }
    >;
    _pinnedReferences?: Array<{
      namespace: string;
      slug: string;
      version: number;
      function: string;
    }>;
  }> {
    const parsed = YAML.parse(sourceYaml);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      return { workflows: this.validate(sourceYaml) };
    }
    if (!Object.hasOwn(parsed, "using")) {
      if (Object.hasOwn(parsed, "with") || Object.hasOwn(parsed, "secrets")) {
        throw new Error("with and secrets are valid only with using");
      }
      return { workflows: this.validate(sourceYaml) };
    }
    if (typeof parsed.using !== "string") {
      throw new Error("using must be namespace/slug@vN");
    }
    if (parsed.steps !== undefined) {
      throw new Error("A workflow must use either steps or using, not both");
    }
    const reference = parsed.using.match(/^([a-z0-9][a-z0-9-]{0,62})\/([a-z0-9][a-z0-9-]{0,62})@v([1-9]\d*)$/);
    if (!reference) {
      throw new Error("using must be namespace/slug@vN");
    }
    const [, namespace, slug, versionText] = reference;
    const version = Number(versionText);
    const recipe = await this.recipes.get(namespace, slug, version);
    if (!recipe) {
      throw new Error("Recipe version not found");
    }
    if (recipe.revoked) {
      throw new Error("Recipe version has been revoked");
    }
    const functions = recipe.functions || {
      main: {
        inputs: recipe.inputs,
        outputs: { type: "object" },
        steps: recipe.steps,
      },
    };
    const selectedFunction =
      parsed.function ??
      (Object.hasOwn(functions, "main")
        ? "main"
        : Object.keys(functions).length === 1
          ? Object.keys(functions)[0]
          : undefined);
    if (typeof selectedFunction !== "string" || !Object.hasOwn(functions, selectedFunction)) {
      throw new Error(
        selectedFunction === undefined
          ? "Recipe exports multiple functions; specify function"
          : `Recipe function not found: ${selectedFunction}`,
      );
    }
    const selected = functions[selectedFunction];
    if (!Object.hasOwn(parsed, "with") || !Object.hasOwn(parsed, "secrets")) {
      throw new Error("using workflows require with and secrets objects");
    }
    const normal = parsed.with;
    const secretRefs = parsed.secrets;
    if (
      !normal ||
      typeof normal !== "object" ||
      Array.isArray(normal) ||
      !secretRefs ||
      typeof secretRefs !== "object" ||
      Array.isArray(secretRefs)
    ) {
      throw new Error("with and secrets must be objects");
    }
    const properties = (selected.inputs as any).properties || {};
    const ordinarySchema = ordinaryRecipeInputSchema(selected.inputs);
    for (const [key, value] of Object.entries(normal)) {
      if (!properties[key] || properties[key].writeOnly === true) {
        throw new Error(`Unknown ordinary recipe input: ${key}`);
      }
      if (typeof value === "string" && /\$\{\s*secrets\./.test(value)) {
        throw new Error(`Secret recipe input "${key}" must use the secrets mapping`);
      }
      if (!(typeof value === "string" && /^\$\{[\s\S]+\}$/.test(value))) {
        validateRecipeInputs(properties[key], value, `with.${key}`);
      }
    }
    for (const [key, definition] of Object.entries(properties)) {
      if (
        (selected.inputs as any).required?.includes(key) &&
        (definition as any)?.writeOnly !== true &&
        !(key in normal)
      ) {
        throw new Error(`Required recipe input is missing: ${key}`);
      }
    }
    for (const [key, value] of Object.entries(secretRefs)) {
      if (
        !properties[key] ||
        (properties[key] as any).writeOnly !== true ||
        typeof value !== "string" ||
        !/^\$\{secrets\.[A-Z][A-Z0-9_]*\}$/.test(value)
      ) {
        throw new Error(`Invalid recipe secret mapping: ${key}`);
      }
    }
    for (const key of (selected.inputs as any).required || []) {
      if (properties[key]?.writeOnly === true && !(key in secretRefs)) {
        throw new Error(`Required recipe secret is missing: ${key}`);
      }
    }
    const recipeSecrets = Object.fromEntries(
      Object.entries(secretRefs).map(([alias, reference]) => [
        alias,
        (reference as string).match(/^\$\{secrets\.([A-Z][A-Z0-9_]*)\}$/)![1],
      ]),
    );
    const bindings = { ...normal, ...secretRefs };
    const referenced = new Set<string>();
    const inspect = (value: any): void => {
      if (typeof value === "string") {
        for (const match of value.matchAll(/\$\{inputs\.([A-Za-z0-9_-]+)\}/g)) {
          referenced.add(match[1]);
        }
      } else if (Array.isArray(value)) {
        value.forEach(inspect);
      } else if (value && typeof value === "object") {
        Object.values(value).forEach(inspect);
      }
    };
    inspect(selected.steps);
    for (const key of referenced) {
      if (!(key in bindings)) {
        throw new Error(`Recipe input is not mapped: ${key}`);
      }
    }
    const rewriteSecrets = (value: any): any => {
      if (typeof value === "string") {
        return value.replace(/\$\{inputs\.([A-Za-z0-9_-]+)\}/g, (match, key: string) =>
          typeof recipeSecrets[key] === "string" ? `\${secrets.${key}}` : match,
        );
      }
      if (Array.isArray(value)) {
        return value.map(rewriteSecrets);
      }
      if (value && typeof value === "object") {
        return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, rewriteSecrets(item)]));
      }
      return value;
    };
    const compiled = {
      ...parsed,
      steps: selected.steps.map(rewriteSecrets),
    };
    delete compiled.using;
    delete compiled.with;
    delete compiled.secrets;
    const workflows = this.validate(YAML.stringify(compiled));
    for (const step of workflows[0].steps) {
      step.__recipeTemplate = true;
    }
    const pinned = await this.collectPinnedReferences(
      selected.steps,
      recipe,
      selectedFunction,
      Object.keys(recipeSecrets),
    );
    (workflows[0] as any)._pinnedReferences = pinned.references;
    (workflows[0] as any)._pinnedRecipeFunctions = pinned.functions;
    const compiledWithRefs = {
      ...parsed,
      steps: selected.steps.map(rewriteSecrets),
      _recipeTemplate: true,
    };
    for (const step of compiledWithRefs.steps) {
      step.__recipeTemplate = true;
    }
    delete compiledWithRefs.using;
    delete compiledWithRefs.with;
    delete compiledWithRefs.secrets;
    const validatedWorkflows = this.validate(YAML.stringify(compiledWithRefs));
    for (const step of validatedWorkflows[0].steps) {
      step.__recipeTemplate = true;
    }
    return {
      workflows,
      recipeRef: { namespace, slug, version },
      recipeInputs: normal,
      recipeInputSchema: ordinarySchema,
      recipeSecrets,
      recipeFunction: selectedFunction,
      recipeOutputs: selected.outputs,
      _pinnedReferences: pinned.references,
      _pinnedRecipeFunctions: pinned.functions,
    };
  }

  /**
   * Collects all pinned (namespace, slug, version, function) references from
   * nested call steps in a recipe.
   * @param steps - The compiled recipe steps (with secrets rewritten)
   * @param recipe - The published Recipe object from the registry
   */
  async collectPinnedReferences(
    steps: any[],
    recipe: Recipe,
    functionName: string,
    rootSecretAliases: string[],
  ): Promise<{
    references: Array<{ namespace: string; slug: string; version: number; function: string }>;
    functions: Record<
      string,
      {
        inputs: Record<string, unknown>;
        outputs: Record<string, unknown>;
        returns?: Record<string, string>;
        steps: any[];
      }
    >;
  }> {
    const references: Array<{
      namespace: string;
      slug: string;
      version: number;
      function: string;
    }> = [];
    const visited = new Set<string>();
    const visiting = new Set<string>();
    const functions: Record<
      string,
      { inputs: Record<string, unknown>; outputs: Record<string, unknown>; steps: any[] }
    > = {};
    const rootKey = `${recipe.namespace}/${recipe.slug}@${recipe.version}#${functionName}`;
    visiting.add(rootKey);

    const inspectSteps = async (
      nestedSteps: any[],
      depth: number,
      availableSecretAliases: Set<string>,
    ): Promise<void> => {
      if (depth > 16) {
        throw new Error("Nested call graph depth exceeds maximum of 16 levels");
      }
      for (const step of nestedSteps) {
        if (!step || typeof step.call !== "string") {
          continue;
        }
        const match = step.call.match(
          /^([a-z0-9][a-z0-9-]{0,62})\/([a-z0-9][a-z0-9-]{0,62})@([1-9][0-9]*)#([A-Za-z_][A-Za-z0-9_]*)$/,
        );
        if (!match) {
          throw new Error(`Invalid nested recipe target: ${String(step.call)}`);
        }
        const [, namespace, slug, versionText, calledFunction] = match;
        const version = Number(versionText);
        if (!Number.isSafeInteger(version)) {
          throw new Error(`Nested recipe version is not a safe integer: ${step.call}`);
        }
        const reference = {
          namespace,
          slug,
          version,
          function: calledFunction,
        };
        const key = `${namespace}/${slug}@${version}#${calledFunction}`;
        if (visiting.has(key)) {
          throw new Error(`Recursive call graph detected involving "${key}"`);
        }
        if (
          !references.some(
            (candidate) =>
              candidate.namespace === namespace &&
              candidate.slug === slug &&
              candidate.version === version &&
              candidate.function === calledFunction,
          )
        ) {
          references.push(reference);
        }
        const nestedRecipe =
          namespace === recipe.namespace && slug === recipe.slug && version === recipe.version
            ? recipe
            : await this.recipes.get(namespace, slug, version);
        if (!nestedRecipe) {
          throw new Error(`Nested recipe version not found: ${namespace}/${slug}@${version}`);
        }
        if (nestedRecipe.revoked) {
          throw new Error(`Nested recipe version has been revoked: ${namespace}/${slug}@${version}`);
        }
        const nestedFunctions = nestedRecipe.functions || {
          main: {
            inputs: nestedRecipe.inputs,
            outputs: { type: "object" },
            steps: nestedRecipe.steps,
          },
        };
        const nestedFunction = nestedFunctions[calledFunction];
        if (!nestedFunction) {
          throw new Error(`Nested recipe function not found: ${calledFunction}`);
        }
        functions[key] = JSON.parse(JSON.stringify(nestedFunction));
        this.validateNestedCallBindings(step, nestedFunction.inputs, availableSecretAliases);
        const contextKey = `${key}\u0000${[...Object.keys(step.secrets || {})].sort().join("\u0000")}`;
        if (visited.has(contextKey)) {
          continue;
        }
        visiting.add(key);
        await inspectSteps(nestedFunction.steps, depth + 1, new Set(Object.keys(step.secrets || {})));
        visiting.delete(key);
        visited.add(contextKey);
      }
    };

    await inspectSteps(steps, 1, new Set(rootSecretAliases));
    return { references, functions };
  }

  private validateNestedCallBindings(
    step: any,
    schema: Record<string, any>,
    availableSecretAliases: Set<string>,
  ): void {
    const properties = schema?.properties || {};
    const ordinary = step.with === undefined ? {} : step.with;
    const secrets = step.secrets === undefined ? {} : step.secrets;
    if (!ordinary || typeof ordinary !== "object" || Array.isArray(ordinary)) {
      throw new Error("Nested call with must be an object");
    }
    if (!secrets || typeof secrets !== "object" || Array.isArray(secrets)) {
      throw new Error("Nested call secrets must be an object");
    }
    for (const [key, value] of Object.entries(ordinary)) {
      const property = properties[key];
      if (!property || property.writeOnly === true) {
        throw new Error(`Unknown ordinary nested recipe input: ${key}`);
      }
      if (typeof value === "string" && value.includes("${")) {
        if (!isSafeRecipeExpression(value)) {
          throw new Error(`Invalid nested recipe expression: with.${key}`);
        }
      } else {
        validateRecipeInputs(property, value, `with.${key}`);
      }
    }
    for (const key of schema?.required || []) {
      if (properties[key]?.writeOnly !== true && !Object.hasOwn(ordinary, key)) {
        throw new Error(`Required nested recipe input is missing: ${key}`);
      }
    }
    for (const [key, reference] of Object.entries(secrets)) {
      if (
        !properties[key] ||
        properties[key].writeOnly !== true ||
        typeof reference !== "string" ||
        !/^\$\{secrets\.[A-Za-z_][A-Za-z0-9_]*\}$/.test(reference) ||
        !availableSecretAliases.has(reference.slice(10, -1))
      ) {
        throw new Error(`Invalid nested recipe secret mapping: ${key}`);
      }
    }
    for (const key of schema?.required || []) {
      if (properties[key]?.writeOnly === true && !Object.hasOwn(secrets, key)) {
        throw new Error(`Required nested recipe secret is missing: ${key}`);
      }
    }
  }

  async validateForSave(sourceYaml: string): Promise<WorkflowDefinition[]> {
    return (await this.resolveRecipeWorkflow(sourceYaml)).workflows;
  }

  private async assertDefinitionIdIsUnique(
    teamId: string | undefined,
    workflowKey: string,
    definitionId: string,
  ): Promise<void> {
    const rows = teamId
      ? await db.all("SELECT id, definition_id FROM workflows WHERE team_id = ?", [teamId])
      : await db.all("SELECT id, definition_id FROM workflows");
    for (const row of rows) {
      if (row.id !== workflowKey && row.definition_id === definitionId) {
        throw new Error(`Workflow id \"${definitionId}\" already exists in this workspace`);
      }
    }
  }

  async saveDraft(id: string, sourceYaml: string, enabled = true): Promise<StoredWorkflow> {
    void id;
    void sourceYaml;
    void enabled;
    throw new Error("Workspace ID is required; use saveDraftForTeam");
  }

  async saveDraftForTeam(teamId: string, id: string, sourceYaml: string, enabled = true): Promise<StoredWorkflow> {
    const resolved = await this.resolveRecipeWorkflow(sourceYaml);
    const workflows = resolved.workflows;
    if (workflows.length !== 1) {
      throw new Error("Workflow must contain exactly one definition");
    }
    const canonicalId = workflowId(id);
    const existing = await db.get("SELECT team_id FROM workflows WHERE id = ?", [canonicalId]);
    if (existing && existing.team_id !== teamId) {
      throw new Error("Workflow not found");
    }
    await this.assertDefinitionIdIsUnique(teamId, canonicalId, workflows[0].id);
    const revision = await db.get(
      "SELECT COALESCE(MAX(revision), 0) AS revision FROM workflow_revisions WHERE workflow_id = ?",
      [canonicalId],
    );
    const nextRevision = Number(revision?.revision || 0) + 1;
    if (typeof db.transaction !== "function") {
      throw new Error("Saving workflow drafts requires database transactions");
    }
    await db.transaction([
      {
        s: `INSERT INTO workflows (id, definition_id, name, source_yaml, status, enabled, team_id) VALUES (?, ?, ?, ?, 'draft', ?, ?)
        ON CONFLICT(id) DO UPDATE SET definition_id = excluded.definition_id, name = excluded.name, source_yaml = excluded.source_yaml, status = 'draft', enabled = excluded.enabled,
        updated_at = CURRENT_TIMESTAMP WHERE workflows.team_id = excluded.team_id`,
        d: [canonicalId, workflows[0].id, workflows[0].name, sourceYaml, enabled ? 1 : 0, teamId],
        m: "run",
      },
      {
        s: `INSERT INTO workflow_revisions (workflow_id, revision, source_yaml, normalized_json)
        SELECT ?, ?, ?, ? WHERE EXISTS (SELECT 1 FROM workflows WHERE id = ? AND team_id = ?)`,
        d: [
          canonicalId,
          nextRevision,
          sourceYaml,
          JSON.stringify(
            resolved.recipeRef
              ? {
                  ...workflows[0],
                  _recipeRef: resolved.recipeRef,
                  _recipeInputs: resolved.recipeInputs,
                  _recipeInputSchema: resolved.recipeInputSchema,
                  _recipeSecrets: resolved.recipeSecrets,
                  _recipeFunction: resolved.recipeFunction,
                  _recipeOutputs: resolved.recipeOutputs,
                  _pinnedReferences: resolved._pinnedReferences,
                  _pinnedRecipeFunctions: resolved._pinnedRecipeFunctions,
                }
              : workflows[0],
          ),
          canonicalId,
          teamId,
        ],
        m: "run",
      },
      {
        s: `UPDATE domain_event_subscriptions SET enabled = 0 WHERE team_id = ? AND workflow_id = ?`,
        d: [teamId, canonicalId],
        m: "run",
      },
      {
        s: `UPDATE domain_event_deliveries SET status = 'filtered', lease_until = NULL,
            last_error = 'Workflow is not published and enabled', updated_at = CURRENT_TIMESTAMP
            WHERE team_id = ? AND status IN ('pending', 'claimed')
              AND subscription_id IN (SELECT id FROM domain_event_subscriptions WHERE team_id = ? AND workflow_id = ?)`,
        d: [teamId, teamId, canonicalId],
        m: "run",
      },
    ]);
    const owner = await db.get("SELECT team_id FROM workflows WHERE id = ?", [canonicalId]);
    if (!owner || owner.team_id !== teamId) {
      throw new Error("Workflow not found");
    }
    return {
      id: canonicalId,
      name: workflows[0].name,
      sourceYaml,
      revision: nextRevision,
      status: "draft",
      enabled,
    };
  }

  async listForTeam(teamId: string): Promise<StoredWorkflow[]> {
    const rows = await db.all(
      "SELECT id, name, source_yaml, COALESCE(active_revision, 0) AS revision, status, enabled FROM workflows WHERE team_id = ? ORDER BY name",
      [teamId],
    );
    return rows.map((row: any) => ({
      id: row.id,
      name: row.name,
      sourceYaml: row.source_yaml,
      revision: Number(row.revision),
      status: row.status,
      enabled: Boolean(row.enabled),
    }));
  }

  async getForTeam(teamId: string, id: string): Promise<StoredWorkflow | null> {
    const row = await db.get(
      "SELECT id, name, source_yaml, COALESCE(active_revision, 0) AS revision, status, enabled FROM workflows WHERE team_id = ? AND id = ?",
      [teamId, id],
    );
    return row
      ? {
          id: row.id,
          name: row.name,
          sourceYaml: row.source_yaml,
          revision: Number(row.revision),
          status: row.status,
          enabled: Boolean(row.enabled),
        }
      : null;
  }

  async setEnabledForTeam(teamId: string, id: string, enabled: boolean): Promise<boolean> {
    if (typeof db.transaction !== "function") {
      throw new Error("Changing workflow state requires database transactions");
    }
    const commands: Array<{ s: string; d: unknown[]; m: "run" }> = [
      {
        s: "UPDATE workflows SET enabled = ?, updated_at = CURRENT_TIMESTAMP WHERE team_id = ? AND id = ?",
        d: [enabled ? 1 : 0, teamId, id],
        m: "run",
      },
    ];
    if (!enabled) {
      commands.push(
        {
          s: "UPDATE domain_event_subscriptions SET enabled = 0 WHERE team_id = ? AND workflow_id = ?",
          d: [teamId, id],
          m: "run",
        },
        {
          s: `UPDATE domain_event_deliveries SET status = 'filtered', lease_until = NULL,
              last_error = 'Workflow is disabled', updated_at = CURRENT_TIMESTAMP
              WHERE team_id = ? AND status IN ('pending', 'claimed')
                AND subscription_id IN (SELECT id FROM domain_event_subscriptions WHERE team_id = ? AND workflow_id = ?)`,
          d: [teamId, teamId, id],
          m: "run",
        },
      );
    } else {
      commands.push({
        s: `INSERT INTO domain_event_subscriptions
              (id, team_id, workflow_id, workflow_revision, event_type, high_water_event_sequence, enabled)
            SELECT lower(hex(randomblob(16))), w.team_id, w.id, w.active_revision, event_type.value,
                   (SELECT COALESCE(MAX(sequence), 0) FROM domain_events e WHERE e.team_id = w.team_id), 1
            FROM workflows w
            JOIN workflow_revisions wr ON wr.workflow_id = w.id AND wr.revision = w.active_revision
            JOIN json_each(json_extract(wr.normalized_json, '$.eventTypes')) AS event_type
            WHERE w.team_id = ? AND w.id = ? AND w.status = 'published' AND w.enabled = 1
            ON CONFLICT(team_id, workflow_id, workflow_revision, event_type)
            DO UPDATE SET enabled = 1, high_water_event_sequence = excluded.high_water_event_sequence`,
        d: [teamId, id],
        m: "run",
      });
    }
    await db.transaction(commands);
    return Boolean(await db.get("SELECT 1 AS present FROM workflows WHERE team_id = ? AND id = ?", [teamId, id]));
  }

  async transferDraftForTeam(sourceTeamId: string, targetTeamId: string, id: string): Promise<boolean> {
    if (sourceTeamId === targetTeamId) {
      return Boolean(await this.getForTeam(sourceTeamId, id));
    }
    const result = await db.run(
      `UPDATE workflows SET team_id = ?, updated_at = CURRENT_TIMESTAMP
       WHERE id = ? AND team_id = ? AND status = 'draft'
         AND NOT EXISTS (SELECT 1 FROM jobs WHERE jobs.workflow_id = workflows.id)
         AND NOT EXISTS (SELECT 1 FROM scheduled_runs WHERE scheduled_runs.workflow_id = workflows.id)`,
      [targetTeamId, id, sourceTeamId],
    );
    return Number(result?.changes || 0) === 1;
  }

  async deleteForTeam(teamId: string, id: string): Promise<boolean> {
    if (!(await this.getForTeam(teamId, id))) {
      return false;
    }
    await db.run("DELETE FROM scheduled_runs WHERE workflow_id = ?", [id]);
    await db.run("DELETE FROM workflow_revisions WHERE workflow_id = ?", [id]);
    await db.run("DELETE FROM workflows WHERE team_id = ? AND id = ?", [teamId, id]);
    return true;
  }

  async publish(id: string): Promise<StoredWorkflow | null> {
    const workflow = await db.get("SELECT * FROM workflows WHERE id = ?", [id]);
    if (!workflow) {
      return null;
    }
    const [definition] = (await this.resolveRecipeWorkflow(workflow.source_yaml)).workflows;
    await this.assertDefinitionIdIsUnique(undefined, id, definition.id);
    const revision = await db.get("SELECT MAX(revision) AS revision FROM workflow_revisions WHERE workflow_id = ?", [
      id,
    ]);
    await db.run(
      "UPDATE workflows SET status = 'published', active_revision = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?",
      [revision.revision, id],
    );
    return {
      id,
      name: workflow.name,
      sourceYaml: workflow.source_yaml,
      revision: Number(revision.revision),
      status: "published",
      enabled: Boolean(workflow.enabled),
    };
  }

  async publishForTeam(teamId: string, id: string): Promise<StoredWorkflow | null> {
    const workflow = await db.get("SELECT * FROM workflows WHERE team_id = ? AND id = ?", [teamId, id]);
    if (!workflow) {
      return null;
    }
    const [definition] = (await this.resolveRecipeWorkflow(workflow.source_yaml)).workflows;
    await this.assertDefinitionIdIsUnique(teamId, id, definition.id);
    const commands: Array<{ s: string; d?: unknown[]; m: "run" }> = [
      {
        s: `UPDATE workflows
            SET status = 'published',
                active_revision = (SELECT MAX(revision) FROM workflow_revisions WHERE workflow_id = workflows.id),
                updated_at = CURRENT_TIMESTAMP
            WHERE team_id = ? AND id = ?
              AND EXISTS (SELECT 1 FROM workflow_revisions WHERE workflow_id = workflows.id)`,
        d: [teamId, id],
        m: "run",
      },
      {
        s: `UPDATE domain_event_subscriptions SET enabled = 0
            WHERE team_id = ? AND workflow_id = ?
              AND EXISTS (SELECT 1 FROM workflows WHERE id = ? AND team_id = ? AND status = 'published')`,
        d: [teamId, id, id, teamId],
        m: "run",
      },
      {
        s: `INSERT INTO domain_event_subscriptions
              (id, team_id, workflow_id, workflow_revision, event_type, high_water_event_sequence, enabled)
            SELECT lower(hex(randomblob(16))), w.team_id, w.id, w.active_revision, event_type.value,
                   (SELECT COALESCE(MAX(sequence), 0) FROM domain_events e WHERE e.team_id = w.team_id), 1
            FROM workflows w
            JOIN workflow_revisions wr ON wr.workflow_id = w.id AND wr.revision = w.active_revision
            JOIN json_each(json_extract(wr.normalized_json, '$.eventTypes')) AS event_type
            WHERE w.team_id = ? AND w.id = ? AND w.status = 'published' AND w.enabled = 1
            ON CONFLICT(team_id, workflow_id, workflow_revision, event_type)
            DO UPDATE SET enabled = 1, high_water_event_sequence = excluded.high_water_event_sequence`,
        d: [teamId, id],
        m: "run",
      },
    ];
    if (typeof db.transaction !== "function") {
      throw new Error("Publishing event subscriptions requires database transactions");
    }
    await db.transaction(commands);
    const published = await db.get(
      `SELECT w.id, w.name, r.source_yaml, w.active_revision AS revision, w.status, w.enabled
       FROM workflows w JOIN workflow_revisions r ON r.workflow_id = w.id AND r.revision = w.active_revision
       WHERE w.team_id = ? AND w.id = ?`,
      [teamId, id],
    );
    if (!published || published.status !== "published") {
      throw new Error("Workflow changed while it was being published; retry publication");
    }
    return {
      id: published.id,
      name: published.name,
      sourceYaml: published.source_yaml,
      revision: Number(published.revision),
      status: published.status,
      enabled: Boolean(published.enabled),
    };
  }

  async list(): Promise<StoredWorkflow[]> {
    const rows = await db.all(
      "SELECT id, name, source_yaml, COALESCE(active_revision, 0) AS revision, status, enabled FROM workflows ORDER BY name",
    );
    return rows.map((row: any) => ({
      id: row.id,
      name: row.name,
      sourceYaml: row.source_yaml,
      revision: Number(row.revision),
      status: row.status,
      enabled: Boolean(row.enabled),
    }));
  }

  async listActive(): Promise<StoredWorkflow[]> {
    const rows = await db.all(`
      SELECT w.id, w.name, r.source_yaml, w.active_revision AS revision, w.status, w.enabled
      FROM workflows w
      JOIN workflow_revisions r ON r.workflow_id = w.id AND r.revision = w.active_revision
      WHERE w.status = 'published' AND w.enabled = 1
      ORDER BY w.name
    `);
    return rows.map((row: any) => ({
      id: row.id,
      name: row.name,
      sourceYaml: row.source_yaml,
      revision: Number(row.revision),
      status: row.status,
      enabled: Boolean(row.enabled),
    }));
  }

  async listActiveForTeam(teamId: string): Promise<StoredWorkflow[]> {
    const rows = await db.all(
      `SELECT w.id, w.name, r.source_yaml, w.active_revision AS revision, w.status, w.enabled
       FROM workflows w
       JOIN workflow_revisions r ON r.workflow_id = w.id AND r.revision = w.active_revision
       WHERE w.team_id = ? AND w.status = 'published' AND w.enabled = 1
       ORDER BY w.name`,
      [teamId],
    );
    return rows.map((row: any) => ({
      id: row.id,
      name: row.name,
      sourceYaml: row.source_yaml,
      revision: Number(row.revision),
      status: row.status,
      enabled: Boolean(row.enabled),
    }));
  }

  async get(id: string): Promise<StoredWorkflow | null> {
    const row = await db.get(
      "SELECT id, name, source_yaml, COALESCE(active_revision, 0) AS revision, status, enabled FROM workflows WHERE id = ?",
      [id],
    );
    return row
      ? {
          id: row.id,
          name: row.name,
          sourceYaml: row.source_yaml,
          revision: Number(row.revision),
          status: row.status,
          enabled: Boolean(row.enabled),
        }
      : null;
  }

  async delete(id: string): Promise<boolean> {
    const workflow = await this.get(id);
    if (!workflow) {
      return false;
    }
    await db.run("DELETE FROM scheduled_runs WHERE workflow_id = ?", [id]);
    await db.run("DELETE FROM workflow_revisions WHERE workflow_id = ?", [id]);
    await db.run("DELETE FROM workflows WHERE id = ?", [id]);
    return true;
  }

  async published(): Promise<WorkflowRevision[]> {
    const rows =
      await db.all(`SELECT w.id AS workflow_id, r.revision, r.normalized_json FROM workflows w JOIN workflow_revisions r
      ON r.workflow_id = w.id AND r.revision = w.active_revision WHERE w.status = 'published' AND w.enabled = 1`);
    return rows.map((row: any) => ({
      workflowId: row.workflow_id,
      revision: Number(row.revision),
      definition: JSON.parse(row.normalized_json),
    }));
  }

  async publishedForTeam(teamId: string): Promise<WorkflowRevision[]> {
    const rows = await db.all(
      `SELECT w.id AS workflow_id, r.revision, r.normalized_json FROM workflows w JOIN workflow_revisions r
      ON r.workflow_id = w.id AND r.revision = w.active_revision WHERE w.team_id = ? AND w.status = 'published' AND w.enabled = 1`,
      [teamId],
    );
    return rows.map((row: any) => ({
      workflowId: row.workflow_id,
      revision: Number(row.revision),
      definition: JSON.parse(row.normalized_json),
    }));
  }

  async getRevision(workflowId: string, revision: number): Promise<WorkflowDefinition | null> {
    const row = await db.get("SELECT normalized_json FROM workflow_revisions WHERE workflow_id = ? AND revision = ?", [
      workflowId,
      revision,
    ]);
    return row ? JSON.parse(row.normalized_json) : null;
  }

  async latestRevision(workflowId: string): Promise<{ revision: number; definition: WorkflowDefinition } | null> {
    const row = await db.get(
      `SELECT revision, normalized_json FROM workflow_revisions
       WHERE workflow_id = ? ORDER BY revision DESC LIMIT 1`,
      [workflowId],
    );
    return row
      ? {
          revision: Number(row.revision),
          definition: JSON.parse(row.normalized_json),
        }
      : null;
  }

  async getRevisionSnapshot(workflowId: string, revision: number): Promise<StoredWorkflow | null> {
    const row = await db.get(
      `SELECT w.id, w.enabled, r.source_yaml, r.normalized_json
       FROM workflows w JOIN workflow_revisions r ON r.workflow_id = w.id
       WHERE w.id = ? AND r.revision = ?`,
      [workflowId, revision],
    );
    if (!row) {
      return null;
    }
    const definition = JSON.parse(row.normalized_json) as WorkflowDefinition;
    return {
      id: row.id,
      name: definition.name,
      sourceYaml: row.source_yaml,
      revision,
      status: "archived",
      enabled: Boolean(row.enabled),
    };
  }

  async claimScheduledRun(workflowId: string, triggerId: string, scheduledFor: string): Promise<boolean> {
    const row = await db.get(
      `INSERT INTO scheduled_runs (workflow_id, trigger_id, scheduled_for) VALUES (?, ?, ?)
      ON CONFLICT(workflow_id, trigger_id, scheduled_for) DO NOTHING RETURNING workflow_id`,
      [workflowId, triggerId, scheduledFor],
    );
    return Boolean(row);
  }
}
