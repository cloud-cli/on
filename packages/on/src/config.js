/**
 * Merges user config overrides with baseline defaults
 */
export function resolveConfig(userConfig = {}) {
    return {
        port: userConfig.port ?? 3000,
        adminToken: userConfig.adminToken ?? process.env.RUNNER_ADMIN_SECRET ?? '',
        sqliteUrl: userConfig.sqliteUrl ?? process.env.DATABASE_URL ?? 'sqlite.db',
        workflowsDir: userConfig.workflowsDir ?? '.on/',
        workersCount: userConfig.workersCount ?? 5,
        storagePath: userConfig.storagePath ?? process.env.RUNNER_TMP ?? '/tmp/workspaces',
        env: userConfig.env ?? {},
        reporters: userConfig.reporters ?? [],
    };
}
//# sourceMappingURL=config.js.map