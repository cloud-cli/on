import { WorkflowPlugin, WorkflowContext } from './types.js';
export declare class PluginManager {
    private plugins;
    register(plugin: WorkflowPlugin): void;
    triggerWorkflowStart(wf: WorkflowContext): Promise<void>;
    triggerWorkflowFinish(wf: WorkflowContext, status: 'success' | 'failed'): Promise<void>;
}
//# sourceMappingURL=manager.d.ts.map