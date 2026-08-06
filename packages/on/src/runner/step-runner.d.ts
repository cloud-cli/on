import type { ExecutionDriver, StepContext } from '../types.js';
export declare function executeStepAndCollectState(stepCtx: StepContext, driver: ExecutionDriver, currentWorkflowEnv: Record<string, string>): Promise<{
    result: import("../types.js").StepResult;
    newEnv: {};
    outputs: {};
}>;
//# sourceMappingURL=step-runner.d.ts.map