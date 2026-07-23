import { spawn, execSync } from "node:child_process";
import { existsSync, readdirSync, readFileSync, unlinkSync } from "node:fs";
import { mkdtemp, rm, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path/posix";
import { loadSecrets } from "./secrets.js";
import type {
  StepDefinition,
  WorkflowContext,
  WorkflowEvent,
  OnConfig,
  WorkflowDefinition,
  StepOutput,
  EventOutput,
  NormalizedStepDefinition,
} from "./types.js";
import { interpolate, withMappings, asObject, toStringProxy } from "./utils.js";
import { randomUUID } from "node:crypto";
import { createReport } from "./reports.js";
import { prepareShell, resetTmpfsState, ensureTmpfsVolume, setTmpfsEnvVars } from "./docker.js";

const SHELL = process.env.SHELL || "sh";

function prepareEnv(context: WorkflowContext) {
  const { workflow, secrets } = context;
  const env = {
    ...process.env,
    ...Object.fromEntries(
      Object.entries(secrets).map(([key, value]) => [key, String(value)]),
    ),
    PWD: context.workingDir,
  } as NodeJS.ProcessEnv;

  if (workflow.env) {
    if (typeof workflow.env !== "object") {
      throw new Error("Workflow env field must be an object.");
    }

    for (const [key, template] of Object.entries(workflow.env)) {
      env[key] = interpolate(template as string, context);
    }
  }

  Object.assign(context.env, env);
}

function getHostMountPoint(volumeName: string): string {
  try {
    const output = execSync(`docker volume inspect -f '{{.Mountpoint}}' ${volumeName}`).toString().trim();
    return output;
  } catch (e) {
    console.warn(`Failed to inspect docker volume:`, e);
    return "";
  }
}

function loadAndCleanTmpfs(context: WorkflowContext, volName: string): Record<string, string> {
  const loaded: Record<string, string> = {};
  const volPath = getHostMountPoint(volName);
  
  if (!volPath || !existsSync(volPath)) return loaded;

  try {
    const files = readdirSync(volPath).filter((f) => f.endsWith(".json"));
    
    for (const file of files) {
      const content = readFileSync(join(volPath, file), "utf-8");
      try {
        const data = JSON.parse(content);
        // Assuming the JSON object contains key-value pairs to expand env
        Object.assign(loaded, withMappings(data, context.workflow.mappings));
      } catch {}
      
      // Remove files as requested
      unlinkSync(join(volPath, file));
    }
  } catch (e) {
    console.warn(`Failed to process tmpfs:`, e);
  }

  return loaded;
}

function validateEvent(eventPayload: WorkflowEvent, config: OnConfig) {
  const { event, source } = eventPayload;
  const eventKeys = Object.keys(event);
  const acceptableEvents = Object.keys(config.on);
  const key = acceptableEvents.find((key) => event[key]);
  const workflow: WorkflowDefinition | null = key ? config.on[key] : null;

  if (!workflow) {
    console.log(
      `No workflow defined for event keys: ${eventKeys.join(", ")}, only accepting ${acceptableEvents.join(", ")}.`,
    );
    return null;
  }

  if (!workflow.steps?.length) {
    console.warn(
      `Workflow for event ${event.source}:${event.event} has no steps defined, skipping.`,
    );
    return null;
  }

  const payload = event[key as string];

  return {
    source,
    workflow: workflow as WorkflowDefinition,
    event: payload as Record<string, unknown>,
  };
}

async function runStep(
  step: NormalizedStepDefinition,
  context: WorkflowContext,
): Promise<StepOutput> {
  const stdout: Buffer[] = [];
  const stderr: Buffer[] = [];
  const cmd = interpolate(step.run, context);

  const shell =
    context.runner === "docker"
      ? prepareShell(step, context)
      : spawn(SHELL, {
          shell: true,
          env: context.env,
          cwd: step.workingDir || context.workingDir,
        });

  shell.stdout?.on("data", (data) => stdout.push(data));
  shell.stderr?.on("data", (data) => stderr.push(data));

  return new Promise<StepOutput>((resolve, reject) => {
    shell.once("error", reject);
    shell.once("exit", (code) => {
      const stepOutput = {
        code: code ?? 0,
        cmd: step.run,
        stdout: Buffer.concat(stdout).toString("utf-8"),
        stderr: Buffer.concat(stderr).toString("utf-8"),
      };

      resolve(stepOutput);
    });

    shell.stdin?.write(cmd);
    shell.stdin?.write("\nexit $?;\n");
    shell.stdin?.end();
  });
}

function normalizeSteps(
  steps: Array<StepDefinition | string>,
  context: WorkflowContext,
): NormalizedStepDefinition[] {
  return steps.map((step) => {
    if (typeof step === "string") {
      step = { run: step };
    }

    if (typeof step.run !== "string") {
      throw new Error("Each workflow step must have a 'run' command string.");
    }

    return step as NormalizedStepDefinition;
  });
}

export async function processEvent(
  incomingEvent: WorkflowEvent,
  config: OnConfig,
  parentId?: string,
): Promise<EventOutput> {
  const id = randomUUID();
  const validated = validateEvent(incomingEvent, config);

  if (!validated) {
    return { id, parentId, children: [], context: null };
  }

  const { workflow, event } = validated;

  const inputs = workflow.mappings
    ? withMappings(event, workflow.mappings)
    : event;

  // Unique ID to ensure the tmpfs volume is consistent across all steps in this run
  const workflowId = randomUUID().slice(0, 8);
  
  const secrets = await loadSecrets(workflow.secrets);
  const workingDir = await mkdtemp(join(tmpdir(), "workflow"));
  const context = toStringProxy<WorkflowContext>({
    inputs: { ...inputs, workflowId }, 
    secrets,
    workflow,
    env: {},
    outputs: [],
    workingDir,
    runner: workflow.runner || "docker",
  });

  if (workflow.if) {
    const conditions = workflow.if.map((c) => interpolate(c, context));
    const shouldRun = conditions.some((c) => Function("return " + c)());

    if (!shouldRun) {
      console.log(
        `Workflow for event ${event.source}:${event.event} skipped due to no matching conditions.`,
      );
      return { id, parentId, children: [], context: null };
    }
  }

  const children = [];

  try {
    prepareEnv(context);
    
    // Initialize tmpfs volume name cache for this workflow run
    resetTmpfsState(workflowId);
    ensureTmpfsVolume(context);

    const steps = normalizeSteps(workflow.steps || [], context);

    for (const step of steps) {
      const output = await runStep(step, context);

      if (output.code !== 0) {
        throw new Error(
          `Step failed with code ${output.code}.\nstdout: ${output.stdout}\nstderr: ${output.stderr}`,
        );
      }

      // Load tmpfs env vars if step used them
      if (step.tmpfs) {
        const currentVolName = typeof step.tmpfs === "string" ? step.tmpfs : ensureTmpfsVolume(context);
        const newEnv = loadAndCleanTmpfs(context, currentVolName);
        
        // Track which keys came from tmpfs so they can be passed to containers via -e flags
        const tmpfsVars = new Set<string>();
        Object.keys(newEnv).forEach((key) => {
          context.env[key] = String(newEnv[key]);
          tmpfsVars.add(key);
        });

        // Update the tracked set for this workflow
        setTmpfsEnvVars(workflowId, tmpfsVars);
      }

      context.outputs.push(output);
    }

    for (const dispatchPath of workflow.triggers ?? []) {
      const next = await processEventFromFile(dispatchPath, config, parentId);
      if (next) {
        children.push(next.id);
      }
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error(`Error processing event: ${message}`);
    console.debug(JSON.stringify(event));
  } finally {
    await rm(context.workingDir, { recursive: true, force: true });
  }

  await createReport({ id, parentId, children }, context);

  return { id, parentId, children, context };
}

export async function processEventFromFile(
  dispatchPath: string,
  config: OnConfig,
  parentId?: string,
) {
  if (!existsSync(dispatchPath)) {
    console.warn(`Trigger file does not exist: ${dispatchPath}`);
    return;
  }

  const raw = await readFile(dispatchPath, "utf8");
  const dispatchedEvent = {
    event: asObject(JSON.parse(raw)),
    source: "file",
  } as WorkflowEvent;
  return await processEvent(dispatchedEvent, config, parentId);
}
