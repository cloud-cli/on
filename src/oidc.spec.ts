import { afterEach, describe, expect, it, vi } from 'vitest';
import { OidcClient } from './oidc.js';

describe('OIDC client', () => {
  afterEach(() => vi.restoreAllMocks());

  it('performs PKCE login and creates a session from userinfo', async () => {
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockImplementation(async (input) => {
      const url = String(input);
      if (url.endsWith('/.well-known/openid-configuration')) {
        return new Response(JSON.stringify({
          authorization_endpoint: 'https://auth.test/authorize',
          token_endpoint: 'https://auth.test/token',
          userinfo_endpoint: 'https://auth.test/userinfo',
        }), { status: 200 });
      }
      if (url.endsWith('/token')) return new Response(JSON.stringify({ access_token: 'access-token' }), { status: 200 });
      if (url.endsWith('/userinfo')) return new Response(JSON.stringify({ id: 'user-1', name: 'Ada' }), { status: 200 });
      throw new Error(`Unexpected request: ${url}`);
    });
    const client = new OidcClient({ providerUrl: 'https://auth.test', clientId: 'runner', clientSecret: 'secret' });

    const loginUrl = await client.loginUrl('https://runner.test/auth/callback', '/runs/42');
    const state = new URL(loginUrl).searchParams.get('state');
    expect(new URL(loginUrl).searchParams.get('code_challenge_method')).toBe('S256');

    const result = await client.completeLogin('code', state!, 'https://runner.test/auth/callback');
    expect(result.returnTo).toBe('/runs/42');
    expect(result.cookie).toContain('runner_oidc_session=');
    expect(client.userFromCookie(result.cookie)).toEqual({ id: 'user-1', name: 'Ada' });
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });

  it('returns scopes from provider token introspection', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(JSON.stringify({ active: true, scope: 'logs:read runs:dispatch' }), { status: 200 }));
    const client = new OidcClient({ providerUrl: 'https://auth.test', clientId: 'runner', clientSecret: 'secret' });
    await expect(client.scopesForToken('token')).resolves.toEqual(['logs:read', 'runs:dispatch']);
  });
});
