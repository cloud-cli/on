import { Reporter } from './reporters/types.js';
export interface RunnerConfig {
    /** Ingress HTTP Gateway Port */
    port: number;
    /** Admin Secret for API / webhook operations */
    adminToken: string;
    /** SQLite Database connection URL / path */
    sqliteUrl: string;
    /** Directory where workflow YAML files live */
    workflowsDir: string;
    /** Number of concurrent worker loops to spawn */
    workersCount: number;
    /** Storage path for job workspaces and step logs */
    storagePath: string;
    /** Global environment variables injected into all step runs */
    env: Record<string, string>;
    /** Registered reporter plugins (JSON, Slack, HTML, etc.) */
    reporters: Reporter[];
}
export type UserRunnerConfig = Partial<RunnerConfig>;
/**
 * Merges user config overrides with baseline defaults
 */
export declare function resolveConfig(userConfig?: UserRunnerConfig): RunnerConfig;
//# sourceMappingURL=config.d.ts.map