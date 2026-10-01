import { URL } from 'node:url';

/**
 * Safely normalize a return URL for use in OIDC authentication flows.
 *
 * Preserves path + query string, rejects protocol-relative URLs, schemes,
 * backslashes, and control characters. The result should be passed through
 * encodeURIComponent when used as a query parameter value (e.g. ?url=<returnTo>).
 *
 * @param requestedReturnTo - The raw return URL string (pathname [?query] [#fragment])
 * @returns A safe path [?query] suitable for OIDC returnTo or as a login
 *   redirect URL. Callers should apply encodeURIComponent when interpolating
 *   the result into a URL query parameter.
 */
export function safeReturnUrl(requestedReturnTo: string): string {
  // Remove fragment first to prevent injection via fragment identifiers.
  const withoutFragment = requestedReturnTo.split('#')[0];

  // ---- Pre-URL-parse validation (the URL parser can sanitize/alter input) ----
  // Reject protocol-relative URLs (starting with //).
  if (withoutFragment.startsWith('//')) return '/runs';

  // Reject backslash-based authority.
  if (withoutFragment.includes('\\')) return '/runs';

  // Reject full URLs with schemes (containing ://).
  if (withoutFragment.includes('://')) return '/runs';

  // Reject CR/LF injection.
  if (withoutFragment.includes('\r') || withoutFragment.includes('\n')) return '/runs';

  // Reject paths that do not start with '/' (must be same-origin relative paths).
  // The URL parser will auto-prefix '/' so we check the raw input.
  if (!withoutFragment.startsWith('/')) return '/runs';

  let path: string;
  let search: string; // includes leading ?, raw query params

  try {
    const parsed = new URL(withoutFragment, 'http://localhost');
    path = parsed.pathname;
    search = parsed.search; // includes leading ?, raw query params
  } catch {
    // Fall back to simple string handling if parsing fails.
    const qIdx = withoutFragment.indexOf('?');
    if (qIdx >= 0) {
      path = withoutFragment.substring(0, qIdx);
      search = withoutFragment.substring(qIdx); // includes leading ?
    } else {
      path = withoutFragment;
      search = '';
    }
  }

  // Reject empty path.
  if (!path) return '/runs';

  // Reconstruct path + query, preserving the raw query string.
  // The caller should apply encodeURIComponent when using this as a query param value.
  return path + (search ? search : '');
}

/**
 * Checks if an OIDC authentication attempt should be allowed for a given
 * request path and HTTP method. This is used to determine whether the global
 * OIDC session check applies.
 *
 * Browser document GET/HEAD requests to UI routes require a valid OIDC session.
 * API endpoints, static assets, OIDC auth routes, and route-specific controls
 * are exempt from this global check.
 *
 * @param pathname - The URL pathname to check
 * @param method - The HTTP method (e.g. 'GET', 'POST', 'HEAD')
 * @returns true if the route is exempt from the global OIDC auth check
 */
export function isExemptFromGlobalOidcAuth(pathname: string, method: string): boolean {
  // Normalize method to uppercase
  const httpMethod = method.toUpperCase();

  // Exempt OIDC auth routes themselves (sign-in, callback, logout)
  if (pathname === '/auth/login' || pathname === '/auth/callback' || pathname === '/auth/logout') {
    return true;
  }

  // Exempt API endpoints: /api exactly and /api/*
  if (pathname === '/api' || pathname.startsWith('/api/')) {
    return true;
  }

  // Exempt static module/template routes
  const staticRoutes = [
    '/manifest.webmanifest',
    '/app-icon.svg',
    '/service-worker.js',
    '/api-client.mjs',
    '/app-header.mjs',
    '/app-router.mjs',
    '/dashboard.mjs',
    '/run.mjs',
    '/settings-ui.mjs',
    '/workflows-ui.mjs',
    '/pages/dashboard.mjs',
    '/pages/run.mjs',
    '/pages/settings-ui.mjs',
    '/pages/workflows-ui.mjs',
    '/app-header.html',
    '/app-router.html',
  ];
  if (staticRoutes.includes(pathname)) {
    return true;
  }

  // Exempt route-specific controls
  if (pathname.startsWith('/restart/') || pathname.startsWith('/webhooks/') || pathname === '/admin/reload-secrets') {
    return true;
  }

  // Exempt POST/OPTIONS/API/service requests from global auth check
  // (only GET/HEAD are subject to browser document auth)
  if (httpMethod !== 'GET' && httpMethod !== 'HEAD') {
    return true;
  }

  return false;
}

/** True only for known browser-document routes that should require an OIDC session. */
export function isProtectedUiRoute(pathname: string, method: string): boolean {
  const httpMethod = method.toUpperCase();
  if ((httpMethod !== 'GET' && httpMethod !== 'HEAD') || isExemptFromGlobalOidcAuth(pathname, httpMethod)) {
    return false;
  }

  return (
    pathname === '/' ||
    pathname === '/runs' ||
    /^\/runs\/\d+$/.test(pathname) ||
    pathname === '/preview' ||
    pathname === '/help' ||
    pathname === '/settings' ||
    /^\/settings\/(workflows|secrets|tokens|notifications|workers)$/.test(pathname) ||
    /^\/settings\/workflows\/(new|[a-z0-9-]+)$/.test(pathname) ||
    pathname === '/workflows' ||
    /^\/workflows\/(new|[a-z0-9-]+)$/.test(pathname) ||
    /^\/pages\/(dashboard|run|help|workflows|settings)\.html$/.test(pathname)
  );
}
