import type { PreprocessedWebhook, WebhookPreprocessor } from '../types.js';
export declare class GitHubPreprocessor implements WebhookPreprocessor {
    name: string;
    parse(headers: Record<string, string>, body: any, rawBodyBuffer: Buffer, secret?: string): PreprocessedWebhook;
}
//# sourceMappingURL=github.d.ts.map