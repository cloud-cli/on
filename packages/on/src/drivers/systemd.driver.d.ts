import { ExecutionDriver, StepContext, StepExecutionHandle } from '../types.js';
export declare class SystemdDriver implements ExecutionDriver {
    name: string;
    /**
     * Check if systemd bus is available on Linux host
     */
    isSupported(): Promise<boolean>;
    execute(ctx: StepContext): Promise<StepExecutionHandle>;
}
//# sourceMappingURL=systemd.driver.d.ts.map