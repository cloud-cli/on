import { afterEach, describe, expect, it, vi } from 'vitest';
import { resolveConfig } from './config.js';

describe('OIDC configuration', () => {
  afterEach(() => vi.unstubAllEnvs());

  it('loads OIDC settings from environment variables', () => {
    vi.stubEnv('RUNNER_OIDC_PROVIDER_URL', 'https://auth.test');
    vi.stubEnv('RUNNER_OIDC_CLIENT_ID', 'runner');
    vi.stubEnv('RUNNER_OIDC_CLIENT_SECRET', 'secret');

    expect(resolveConfig({}, {}).oidc).toEqual({
      providerUrl: 'https://auth.test',
      clientId: 'runner',
      clientSecret: 'secret',
    });
  });

  it('uses DATABASE_URL for the database module and CLI values take precedence', () => {
    vi.stubEnv('DATABASE_URL', 'file:///env/database.mjs');

    expect(resolveConfig({}, {}).database).toBe('file:///env/database.mjs');
    expect(resolveConfig({}, { database: 'file:///cli/database.mjs' }).database).toBe('file:///cli/database.mjs');
  });

  it('prefers file OIDC settings over environment variables', () => {
    vi.stubEnv('RUNNER_OIDC_PROVIDER_URL', 'https://env.test');
    vi.stubEnv('RUNNER_OIDC_CLIENT_ID', 'env-client');
    vi.stubEnv('RUNNER_OIDC_CLIENT_SECRET', 'env-secret');
    const oidc = { providerUrl: 'https://file.test', clientId: 'file-client', clientSecret: 'file-secret' };

    expect(resolveConfig({ oidc }, {}).oidc).toEqual(oidc);
  });
});
