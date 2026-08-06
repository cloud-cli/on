export interface PreprocessedWebhook {
  isValid: boolean;
  event: string;
  inputs: Record<string, any>;
  rawBody: any;
}

export interface WebhookPreprocessor {
  name: string;
  parse(headers: Record<string, string>, body: any, rawBodyBuffer: Buffer, secret?: string): PreprocessedWebhook;
}

export interface WorkflowDefinition {
  id: string;
  name: string;
  on: {
    provider: string; // 'github', 'generic', etc.
    if?: string; // Expression: "inputs.event == 'push' && inputs.branch == 'main'"
  };
  concurrency?: {
    group: string;
    cancelInProgress?: boolean;
  };
  steps: any[];
}

export interface WebhookServerOptions {
  queue: QueueManager;
  secrets: SecretStore;
  adminToken: string;
  workflows: WorkflowDefinition[];
}

