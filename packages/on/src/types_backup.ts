export interface ServerOptions {
  port: number;
  host: string;
  configPath: string;
  daemon: boolean;
}

export interface StepConfig {
  image?: string;
  volumes?: Record<string, string>;
  args?: Array<Record<string, string>>;
}

export interface StepDefinition extends StepConfig {
  run: string;
}

export interface StepOutput {
  code: number;
  cmd: string;
  stdout: string;
  stderr: string;
}

export interface EventOutput {
  id: string;
  parentId?: string;
  children?: string[];
  context: WorkflowContext | null;
}

export interface NormalizedStepDefinition extends StepConfig {
  run: string;
  image: string;
  args: Array<Record<string, string>>;
  volumes: Record<string, string>;
  workingDir?: string;
}

export interface WorkflowDefinition {
  runner?: "docker" | "shell";
  secrets?: string[];
  mappings?: Record<string, string>;
  env?: Record<string, string>;
  defaults?: Partial<StepConfig>;
  steps?: StepDefinition[] | string[];
  triggers?: string[];
  if?: string[];
}

export interface WorkflowContext {
  runner: "docker" | "shell";
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
