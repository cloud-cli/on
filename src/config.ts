import { RunnerConfig, UserRunnerConfig } from './types.js';

/**
 * Merges user config overrides with baseline defaults
 */
export function resolveConfig(configFromFile: UserRunnerConfig, configFromCli: UserRunnerConfig): RunnerConfig {
  return {
    port: configFromFile.port ?? configFromCli.port ?? 11235,
    adminToken: configFromFile.adminToken ?? process.env.RUNNER_ADMIN_SECRET ?? '',
    database: configFromFile.database ?? configFromCli.database ?? process.env.DATABASE_URL ?? '',
    workflows: configFromFile.workflows ?? configFromCli.workflows ?? '.on/',
    workers: configFromFile.workers ?? configFromCli.workers ?? 5,
    storagePath: configFromFile.storagePath ?? process.env.RUNNER_TMP ?? '/tmp/workspaces',
    env: configFromFile.env ?? {},
    reporters: configFromFile.reporters ?? [],
  };
}
