export interface ServerOptions {
  port: number;
  host: string;
  configPath: string;
  daemon: boolean;
}

export interface StepDefinition {
  run: string;
  args?: Array<Record<string, string>>;
  workingDir?: string;
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
  error?: any;
}

export interface NormalizedStepDefinition extends Record<string, any> {
  run: string;
  args: Array<Record<string, string>>;
  workingDir: string;
  envDir: string;
}

export interface WorkflowDefinition {
  runner: 'docker' | 'shell';
  secrets?: string[];
  mappings?: Record<string, string>;
  env?: Record<string, string>;
  defaults?: any;
  steps?: StepDefinition[] | string[];
  if?: string[];
}

export interface WorkflowContext {
  source: string;
  runner: string;
  inputs: Record<string, unknown>;
  outputs: Array<StepOutput>;
  secrets: Record<string, string>;
  workflow: WorkflowDefinition;
  workflowId: string;
  env: NodeJS.ProcessEnv;
  workingDir: string;
  steps: Array<NormalizedStepDefinition>;
}

export interface OnConfig {
  description?: string;
  on: Record<string, WorkflowDefinition>;
}

export type WorkflowEventInputs = Record<string, unknown>;

export interface WorkflowEvent {
  id?: string;
  source: string;
  event: WorkflowEventInputs;
}

export interface Runner {
  setup?(wf: WorkflowDefinition, inputs: WorkflowEventInputs): Promise<void>;
  teardown?(wf: WorkflowDefinition, inputs: WorkflowEventInputs): Promise<void>;
  run(
    wf: WorkflowDefinition,
    inputs: WorkflowEventInputs,
    step: StepDefinition,
    context: WorkflowContext,
  ): Promise<StepOutput>;
}

export interface Report {
  id: string;
  parentId?: string;
  children?: string[];
  outputs: StepOutput[];
  context: WorkflowContext | null;
}
