import { existsSync, statSync } from 'node:fs';
import { resolve } from 'node:path';
import { setUrl } from './db-client.js';
import { RunnerConfig, UserRunnerConfig } from './types.js';

export async function loadConfig(): Promise<RunnerConfig | null> {
  const configFromCli: UserRunnerConfig = {
    port: Number(values.port),
    database: values.database,
    workflows: values.workflows,
    workers: values.workers ? Number(values.workers) : undefined,
  };

  let configFromFile = {};
  const configPath = resolve(values.config);

  if (existsSync(configPath) && statSync(configPath).isFile()) {
    configFromFile = (await import(configPath)).default || {};
  }

  const config = resolveConfig(configFromFile, configFromCli);

  if (!existsSync(config.workflows)) {
    console.warn(`⚠️ Warning: Workflows directory '${config.workflows}' not found.`);
    return null;
  }

  setUrl(config.database);

  return config;
}

export function resolveConfig(configFromFile: UserRunnerConfig, configFromCli: UserRunnerConfig): RunnerConfig {
  const _ = process.env;
  return {
    port: Number(configFromFile.port || configFromCli.port || _.PORT || 11235),
    adminToken: configFromFile.adminToken ?? _.RUNNER_ADMIN_SECRET ?? '',
    database: configFromFile.database ?? configFromCli.database ?? _.RUNNER_DATABASE_URL ?? '',
    workflows: configFromFile.workflows ?? configFromCli.workflows ?? _.RUNNER_WORKFLOWS ?? 'on/',
    workers: Number(configFromFile.workers ?? configFromCli.workers ?? _.RUNNER_WORKERS ?? 5),
    storagePath: configFromFile.storagePath ?? _.RUNNER_TMP ?? '/tmp/workspaces',
    env: configFromFile.env ?? {},
    reporters: configFromFile.reporters ?? [],
  };
}
