import type { StepOutput } from "@cloud-cli/on-devkit";

export interface ServerOptions {
  port: number;
  host: string;
  configPath: string;
  daemon: boolean;
}

export interface StepDefinition {
  workingDir?: string;
  runner?: string;
  run: string;
}

export interface WorkflowRunner {
  run(
    cmd: StepDefinition,
    context: WorkflowContext,
  ): Promise<StepOutput> | void;
}

export interface EventOutput {
  id: string;
  parentId?: string;
  children?: string[];
  context: WorkflowContext | null;
}

export interface WorkflowDefinition {
  runner?: string;
  secrets?: string[];
  mappings?: Record<string, string>;
  env?: Record<string, string>;
  defaults?: Partial<StepDefinition>;
  steps?: StepDefinition[] | string[];
  triggers?: string[];
  if?: string[];
}

export interface WorkflowContext {
  runner: string;
  inputs: Record<string, unknown>;
  outputs: Array<StepOutput>;
  secrets: Record<string, string>;
  workflow: WorkflowDefinition;
  env: NodeJS.ProcessEnv;
  workingDir: string;
}

export interface OnConfig {
  description?: string;
  on: Record<string, Record<string, WorkflowDefinition>>;
}

export interface WorkflowEvent {
  source: string;
  event: { [key: string]: unknown };
}
