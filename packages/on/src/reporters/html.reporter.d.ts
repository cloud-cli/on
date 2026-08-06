import { Reporter, WorkflowExecutionReport } from './types.js';
export declare class HtmlReporter implements Reporter {
    name: string;
    private outputDir;
    private ansiUp;
    constructor(options: {
        outputDir: string;
    });
    report(execReport: WorkflowExecutionReport): Promise<void>;
    /**
     * Render standalone HTML template using Tailwind CSS via CDN
     */
    generateHtml(execReport: WorkflowExecutionReport): string;
}
//# sourceMappingURL=html.reporter.d.ts.map