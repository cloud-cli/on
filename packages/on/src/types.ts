export interface CliOptions {
  port: number;
  host: string;
  configPath?: string;
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
  secrets: Record<string, string>;
  workflow: WorkflowDefinition;
  env: NodeJS.ProcessEnv;
}

export interface OnConfig {
  on?: Record<string, Record<string, WorkflowDefinition>>;
}

export interface WorkflowEvent {
  source: string;
  event: string;
  [key: string]: unknown;
}
