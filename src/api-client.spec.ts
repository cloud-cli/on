import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { loadToken, setApiToken } from '../src/api-client.mjs';

afterEach(() => {
  vi.restoreAllMocks();
});

describe('api-client.mjs loadToken() behavioral fix', () => {
  // Set up jsdom-style window and sessionStorage before each test
  beforeEach(() => {
    // jsdom provides window.sessionStorage globally
    // Mock fetch to control /api/auth/token responses
    vi.spyOn(window, 'fetch', 'mock').mockResolvedValue(new Response('Unauthorized', { status: 401 }));
  });

  it('redirects on 401 from /api/auth/token even without prior cached token', async () => {
    const { loadToken } = await import('../src/api-client.mjs', { assert: { type: 'module' } });

    const result = await loadToken();

    // Should have redirected to /auth/login?url=<encoded current page>
    expect(window.location.assign).toHaveBeenCalledWith(
      expect.stringContaining('/auth/login?url='),
    );
    const url = new URL(window.location.assign.mock.calls[0][0]);
    expect(url.pathname).toBe('/auth/login');
    expect(url.search).toContain('url=');
    // result is undefined after redirect
    expect(result).toBeUndefined();
  });

  it('does NOT redirect on 503 from /api/auth/token', async () => {
    // Override the fetch mock for this test
    vi.spyOn(window, 'fetch', 'mock').mockResolvedValue(new Response('Service unavailable', { status: 503 }));

    const { loadToken } = await import('../src/api-client.mjs', { assert: { type: 'module' } });

    const result = await loadToken();

    // Should NOT redirect on 503
    expect(window.location.assign).not.toHaveBeenCalled();
    // Should return empty string
    expect(result).toBe('');
  });

  it('successful OIDC token acquisition stores token', async () => {
    // Override the fetch mock for this test
    vi.spyOn(window, 'fetch', 'mock').mockResolvedValue(new Response(
      JSON.stringify({ access_token: 'abc123', expires_at: Date.now() + 3600000 }),
      { status: 200, headers: { 'content-type': 'application/json' } },
    ));

    const { loadToken } = await import('../src/api-client.mjs', { assert: { type: 'module' } });

    const token = await loadToken();

    expect(token).toBe('abc123');
  });

  it('manual API key via setApiToken is preserved and loadToken returns it immediately', async () => {
    const { loadToken, setApiToken } = await import('../src/api-client.mjs', { assert: { type: 'module' } });

    // Set a manual API key
    setApiToken('saved-api-key-456');

    // loadToken should return the manual token immediately without fetching
    const token = await loadToken();

    expect(token).toBe('saved-api-key-456');
    // fetch should NOT have been called
    expect(window.fetch).not.toHaveBeenCalled();
  });

  it('does NOT redirect on 401 when manual API key is set and token is fresh', async () => {
    const { loadToken, setApiToken } = await import('../src/api-client.mjs', { assert: { type: 'module' } });

    // Set a manual API key - this makes the token "fresh" so loadToken returns early
    setApiToken('fresh-key-789');

    const token = await loadToken();

    expect(token).toBe('fresh-key-789');
    // fetch should NOT have been called since the fresh manual token triggers early return
    expect(window.fetch).not.toHaveBeenCalled();
  });
});