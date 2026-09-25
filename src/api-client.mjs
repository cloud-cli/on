let token = sessionStorage.getItem('runner-api-token') || '';
let expiresAt = token ? Number.MAX_SAFE_INTEGER : 0;

const rawFetch = window.fetch.bind(window);

async function loadToken() {
  if (token && expiresAt > Date.now() + 30_000) return token;
  const response = await rawFetch('/api/auth/token', { headers: { accept: 'application/json' } });
  if (!response.ok) return '';
  const data = await response.json();
  token = data.access_token || '';
  expiresAt = Number(data.expires_at || 0);
  return token;
}

export async function apiFetch(input, init = {}) {
  const target = new URL(input, window.location.href);
  if (target.origin !== window.location.origin || (!target.pathname.startsWith('/api/') && !target.pathname.startsWith('/restart/'))) {
    return rawFetch(input, init);
  }
  const headers = new Headers(init.headers);
  const accessToken = await loadToken();
  if (accessToken) headers.set('authorization', `Bearer ${accessToken}`);
  return rawFetch(input, { ...init, headers });
}

export function setApiToken(value) {
  token = value || '';
  expiresAt = token ? Number.MAX_SAFE_INTEGER : 0;
  if (token) sessionStorage.setItem('runner-api-token', token);
  else sessionStorage.removeItem('runner-api-token');
}
