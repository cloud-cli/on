import { WebhookPreprocessor, WebhookServerOptions } from './types.js';
export declare class WebhookServer {
    private server;
    private preprocessors;
    private workflows;
    private queue;
    private secrets;
    private adminToken;
    static withPort(options: WebhookServerOptions & {
        port: number;
    }): Promise<void>;
    constructor(options: WebhookServerOptions);
    registerPreprocessor(preprocessor: WebhookPreprocessor): void;
    private handleRequest;
    /**
     * Processes incoming HTTP webhooks
     */
    private handleWebhook;
    /**
     * Handles Zero-Downtime Secret Reload
     */
    private handleSecretReload;
    /**
     * Serves the Server Health & Jobs Dashboard
     */
    private renderDashboard;
    /**
     * Serves single job HTML report
     */
    private renderRunDetails;
    listen(port: number): Promise<void>;
}
//# sourceMappingURL=server.d.ts.map