import { StepContext, StepResult } from '../types.js';
export interface IngressContext {
    provider: string;
    headers: Record<string, string>;
    body: any;
    rawBuffer: Buffer;
}
export interface WorkflowContext {
    jobId: string;
    workflowName: string;
    inputs: Record<string, any>;
    env: Record<string, string>;
}
export interface WorkflowPlugin {
    name: string;
    /** Verify HMAC or signatures */
    onAuthenticate?: (ctx: IngressContext) => Promise<boolean> | boolean;
    /** Convert raw body/headers into normalized inputs */
    onTransform?: (ctx: IngressContext) => Promise<Record<string, any>> | Record<string, any>;
    /** Final gatekeeper check (return false to drop job before enqueueing) */
    onFilter?: (inputs: Record<string, any>, ctx: IngressContext) => Promise<boolean> | boolean;
    /** Runs before any steps execute (e.g. notify Slack, update GitHub status to "Pending") */
    onWorkflowStart?: (wf: WorkflowContext) => Promise<void>;
    /** Runs right before a step executes (e.g. inject dynamic secrets, prepare workspace) */
    onStepBefore?: (step: StepContext, wf: WorkflowContext) => Promise<void>;
    /** Runs after a step finishes (e.g. parse outputs, stream step metrics) */
    onStepAfter?: (step: StepContext, result: StepResult, wf: WorkflowContext) => Promise<void>;
    /** Runs when workflow succeeds or fails (e.g. update GitHub status to "Success/Failure", wipe layers) */
    onWorkflowFinish?: (wf: WorkflowContext, status: 'success' | 'failed', error?: Error) => Promise<void>;
}
//# sourceMappingURL=types.d.ts.map