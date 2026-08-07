import { RunnerConfig, UserRunnerConfig } from './types.js';

/**
 * Merges user config overrides with baseline defaults
 */
export function resolveConfig(configFromFile: UserRunnerConfig, configFromCli: UserRunnerConfig): RunnerConfig {
  return {
    port: configFromFile.port ?? configFromCli.port ?? 11235,
    adminToken: configFromFile.adminToken ?? process.env.RUNNER_ADMIN_SECRET ?? '',
    sqliteUrl: configFromFile.sqliteUrl ?? configFromCli.sqliteUrl ?? process.env.DATABASE_URL ?? '',
    workflowsDir: configFromFile.workflowsDir ?? configFromCli.workflowsDir ?? '.on/',
    workersCount: configFromFile.workersCount ?? configFromCli.workersCount ?? 5,
    storagePath: configFromFile.storagePath ?? process.env.RUNNER_TMP ?? '/tmp/workspaces',
    env: configFromFile.env ?? {},
    reporters: configFromFile.reporters ?? [],
  };
}
