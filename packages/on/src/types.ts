export interface ServerOptions {
  port: number;
  host: string;
  configPath?: string;
  daemon?: boolean;
}

export interface StepConfig {
  image?: string;
  volumes?: Record<string, string>;
  args?: Array<Record<string, string>>;
}

export interface StepDefinition extends StepConfig {
  run: string;
}

export interface NormalizedStepDefinition extends StepConfig {
  run: string;
  image: string;
  args: Array<Record<string, string>>;
  volumes: Record<string, string>;
}

export interface WorkflowDefinition {
  secrets?: string[];
  mappings?: Record<string, string>;
  env?: Record<string, string>;
  defaults?: Partial<StepConfig>;
  steps?: StepDefinition[] | string[];
  triggers?: string[];
}

export interface WorkflowContext {
  inputs: Record<string, unknown>;
  outputs: Record<string, unknown>;
  secrets: Record<string, string>;
  workflow: WorkflowDefinition;
  env: NodeJS.ProcessEnv;
  workingDir: string;
}

export interface OnConfig {
  on: Record<string, Record<string, WorkflowDefinition>>;
}

export interface WorkflowEvent {
  [key: string]: unknown;
}
