export interface CliOptions {
  port: number;
  host: string;
  configPath?: string;
}

export interface WorkflowDefinition {
  secrets?: string[];
  mappings?: Record<string, string>;
  env?: Record<string, string>;
  defaults?: {
    image?: string;
    volumes?: Record<string, string>;
    args?: Record<string, string | number | boolean>;
  };
  steps?: string[];
  dispatch?: string[];
}

export interface OnConfig {
  on?: Record<string, Record<string, WorkflowDefinition>>;
}

export interface WorkflowEvent {
  source: string;
  event: string;
  [key: string]: unknown;
}
