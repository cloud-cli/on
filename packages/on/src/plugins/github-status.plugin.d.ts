import { WorkflowPlugin, WorkflowContext } from './types.js';
export declare class GitHubStatusPlugin implements WorkflowPlugin {
    name: string;
    onWorkflowStart(wf: WorkflowContext): Promise<void>;
    onWorkflowFinish(wf: WorkflowContext, status: 'success' | 'failed'): Promise<void>;
    private updateStatus;
}
//# sourceMappingURL=github-status.plugin.d.ts.map