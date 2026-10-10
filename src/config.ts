import { existsSync, statSync } from "node:fs";
import { resolve } from "node:path";
import type { RunnerConfig, UserRunnerConfig } from "./types.js";
import { parseArgs } from "node:util";

export async function loadConfig(values): Promise<RunnerConfig | null> {
  const configFromCli: UserRunnerConfig = {
    port: Number(values.port),
    database: values.database,
    workers: values.workers ? Number(values.workers) : undefined,
  };

  let configFromFile = {};
  const configPath = resolve(values.config);

  if (existsSync(configPath) && statSync(configPath).isFile()) {
    configFromFile = (await import(configPath)).default || {};
  }

  const config = resolveConfig(configFromFile, configFromCli);

  const command = values.command;
  const apiOnly = command === "start-workers";
  if (!apiOnly && !config.database) {
    console.error("DATABASE_URL is required. Set DATABASE_URL or pass --database.");
    return null;
  }
  if (config.database) process.env.DATABASE_URL = config.database;

  return config;
}

export function resolveConfig(configFromFile: UserRunnerConfig, configFromCli: UserRunnerConfig): RunnerConfig {
  const _ = process.env;
  const port = Number(configFromFile.port || configFromCli.port || _.PORT || 11235);
  const configuredTags = configFromFile.tags ?? (_.RUNNER_TAGS ? _.RUNNER_TAGS.split(",") : []);
  const oidcProviderUrl = _.OIDC_ISSUER ?? _.RUNNER_OIDC_PROVIDER_URL;
  const oidcClientId = _.OIDC_CLIENT_ID ?? _.RUNNER_OIDC_CLIENT_ID;
  const oidcClientSecret = _.OIDC_CLIENT_SECRET ?? _.RUNNER_OIDC_CLIENT_SECRET;
  return {
    port,
    adminToken: configFromFile.adminToken ?? _.RUNNER_ADMIN_SECRET ?? "",
    workerToken: configFromFile.workerToken ?? _.RUNNER_WORKER_SECRET ?? "",
    runnerId: configFromFile.runnerId ?? _.RUNNER_ID,
    runnerCredential: configFromFile.runnerCredential ?? _.RUNNER_CREDENTIAL,
    runnerCredentialPath: configFromFile.runnerCredentialPath ?? _.RUNNER_CREDENTIAL_FILE,
    runnerEnrollCode: configFromFile.runnerEnrollCode ?? _.RUNNER_ENROLLMENT_CODE,
    runnerUpdateAdapter: configFromFile.runnerUpdateAdapter ?? _.RUNNER_UPDATE_ADAPTER,
    database: configFromFile.database ?? configFromCli.database ?? _.DATABASE_URL ?? "",
    workers: Number(configFromFile.workers ?? configFromCli.workers ?? _.RUNNER_WORKERS ?? 5),
    serverUrl: configFromFile.serverUrl ?? _.RUNNER_SERVER_URL ?? `http://127.0.0.1:${port}`,
    tags: configuredTags.map((tag) => tag.trim()).filter(Boolean),
    storagePath: configFromFile.storagePath ?? _.RUNNER_TMP ?? "/tmp/workspaces",
    beta: /^(1|true|yes)$/i.test(_.BETA ?? ""),
    env: configFromFile.env ?? {},
    plugins: configFromFile.plugins ?? [],
    push:
      configFromFile.push ??
      (_.RUNNER_VAPID_PUBLIC_KEY && _.RUNNER_VAPID_PRIVATE_KEY
        ? {
            publicKey: _.RUNNER_VAPID_PUBLIC_KEY,
            privateKey: _.RUNNER_VAPID_PRIVATE_KEY,
            subject: _.RUNNER_VAPID_SUBJECT ?? `mailto:admin@localhost`,
          }
        : undefined),
    oidc:
      configFromFile.oidc ??
      (oidcProviderUrl && oidcClientId && oidcClientSecret
        ? {
            providerUrl: oidcProviderUrl,
            clientId: oidcClientId,
            clientSecret: oidcClientSecret,
          }
        : undefined),
  };
}

export function printHelp() {
  console.log(`
🏃 Runner CLI 🏃

Usage:
  npx -y @cloud-cli/on <command> [options]
  pnpm dlx -y @cloud-cli/on <command> [options]

Commands:
    start-server    Runs Webhook Ingress Server only (API Gateway mode)
    start-scheduler Runs cron and solar workflow triggers
    start-workers   Runs API-only worker (no DATABASE_URL required)
    start-workers-legacy Runs the legacy database-connected worker
    promote-admin   Promote an existing OIDC user (requires --subject)

Options:
  -c, --config     Path to runner.config.mjs (default: ./runner.config.mjs, env: RUNNER_CONFIG_PATH)
   -d, --database   Node.js database module URL (env: DATABASE_URL)
  -p, --port       Port for Webhook Ingress Server (default: 11235, env: PORT)
   -k, --workers    Maximum concurrent jobs (default: 5, env: RUNNER_WORKERS)
                    Worker tags (comma-separated env: RUNNER_TAGS)
                    Webhook server URL (env: RUNNER_SERVER_URL)
                    OIDC settings (env: OIDC_ISSUER, OIDC_CLIENT_ID, OIDC_CLIENT_SECRET)
    -h, --help       Show this help message
  `);
}

export async function loadFromArgs(
  defaultCommand = "start",
): Promise<{ config: RunnerConfig | null; command: string; subject?: string }> {
  const { values, positionals } = parseArgs({
    allowPositionals: true,
    options: {
      config: { type: "string", short: "c", default: process.env.RUNNER_CONFIG_FILE || "./runner.config.mjs" },
      database: { type: "string", short: "d" },
      port: { type: "string", short: "p" },
      workers: { type: "string", short: "k" },
      subject: { type: "string" },
      help: { type: "boolean", short: "h" },
    },
  });

  if (values.help) {
    printHelp();
    process.exit(0);
  }

  const command = positionals[0] || defaultCommand;
  const config = await loadConfig({ ...values, command });

  return {
    config,
    command,
    subject: values.subject,
  };
}
