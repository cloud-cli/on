import { Reporter, WorkflowExecutionReport } from './types.js';
export declare class SlackReporter implements Reporter {
    name: string;
    private token;
    private channel;
    private notifyOn;
    constructor(options: {
        token: string;
        channel: string;
        notifyOn?: ('success' | 'failed')[];
    });
    report(execReport: WorkflowExecutionReport): Promise<void>;
}
//# sourceMappingURL=slack.reporter.d.ts.map