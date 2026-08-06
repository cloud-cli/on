import { Reporter, WorkflowExecutionReport } from './types.js';
export declare class JsonFileReporter implements Reporter {
    name: string;
    private outputDir;
    constructor(options: {
        outputDir: string;
    });
    report(execReport: WorkflowExecutionReport): Promise<void>;
}
//# sourceMappingURL=json-file.reporter.d.ts.map