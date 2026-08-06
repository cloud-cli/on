import { ExecutionDriver, StepContext, StepExecutionHandle } from '../types.js';
export declare class StandardProcessDriver implements ExecutionDriver {
    name: string;
    isSupported(): Promise<boolean>;
    execute(ctx: StepContext): Promise<StepExecutionHandle>;
    /**
     * Kills the entire process group tree (-PID) with unref escalation
     */
    private killProcessGroup;
}
//# sourceMappingURL=standard-process.driver.d.ts.map