import { describe, expect, it, vi } from 'vitest';
import { WebhookServer } from './server.js';

type TestResponse = {
  writeHead: ReturnType<typeof vi.fn>;
  end: ReturnType<typeof vi.fn>;
};

function invokeRequireAdmin({
  authenticated = false,
  admin = false,
  method = 'GET',
  url = '/settings/workflows',
} = {}) {
  const response: TestResponse = {
    writeHead: vi.fn().mockReturnThis(),
    end: vi.fn(),
  };
  const server = {
    isAdmin: () => admin,
    oidc: { userFromCookie: () => (authenticated ? { id: 'user-1' } : undefined) },
  };
  const request = { method, url, headers: { cookie: authenticated ? 'runner_oidc_session=session' : undefined } };

  const allowed = (WebhookServer.prototype as any).requireAdmin.call(server, request, response);

  return { allowed, response };
}

describe('browser admin-route authorization', () => {
  it('sends authenticated non-admin OIDC users to their useful settings page', () => {
    const { allowed, response } = invokeRequireAdmin({ authenticated: true });

    expect(allowed).toBe(false);
    expect(response.writeHead).toHaveBeenCalledWith(302, { Location: '/settings/tokens' });
    expect(response.end).toHaveBeenCalledOnce();
  });

  it('redirects signed-out visitors to sign-in with the original route and query', () => {
    const { allowed, response } = invokeRequireAdmin({ url: '/settings/workflows/build?revision=3' });

    expect(allowed).toBe(false);
    expect(response.writeHead).toHaveBeenCalledWith(302, {
      Location: '/auth/login?url=%2Fsettings%2Fworkflows%2Fbuild%3Frevision%3D3',
    });
  });

  it('allows admins and keeps non-browser API failures as 401', () => {
    const admin = invokeRequireAdmin({ authenticated: true, admin: true });
    expect(admin.allowed).toBe(true);
    expect(admin.response.writeHead).not.toHaveBeenCalled();

    const api = invokeRequireAdmin({ method: 'POST', url: '/api/workflows' });
    expect(api.allowed).toBe(false);
    expect(api.response.writeHead).toHaveBeenCalledWith(401, { 'Content-Type': 'application/json; charset=utf-8' });
  });
});
