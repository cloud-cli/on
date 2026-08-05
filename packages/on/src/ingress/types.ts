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
