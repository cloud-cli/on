export interface StepReport {
    id: string;
    name: string;
    status: 'success' | 'failed' | 'skipped' | 'cancelled';
    durationMs: number;
    exitCode: number;
    error?: string;
    outputs: Record<string, any>;
    logFilePath: string;
}
export interface WorkflowExecutionReport {
    jobId: string;
    workflowName: string;
    status: 'success' | 'failed' | 'cancelled';
    durationMs: number;
    startedAt: string;
    finishedAt: string;
    inputs: Record<string, any>;
    environment: Record<string, string>;
    steps: StepReport[];
    artifacts: string[];
    rerunToken: string;
}
export interface Reporter {
    name: string;
    report(execReport: WorkflowExecutionReport): Promise<void>;
}
//# sourceMappingURL=types.d.ts.map