import crypto from 'node:crypto';

export interface OidcConfig {
  providerUrl: string;
  clientId: string;
  clientSecret: string;
}

interface OidcMetadata {
  authorization_endpoint: string;
  token_endpoint: string;
  userinfo_endpoint: string;
}

export interface OidcUser {
  id: string;
  name?: string;
  email?: string;
  photo?: string;
  role?: string;
}

interface LoginState {
  verifier: string;
  returnTo: string;
  expiresAt: number;
}

interface Session {
  user: OidcUser;
  accessToken: string;
  accessTokenExpiresAt: number;
  expiresAt: number;
}

const STATE_TTL_MS = 10 * 60 * 1000;
const SESSION_TTL_MS = 8 * 60 * 60 * 1000;
const SESSION_COOKIE = 'runner_oidc_session';

export class OidcClient {
  private metadata?: OidcMetadata;
  private readonly states = new Map<string, LoginState>();
  private readonly sessions = new Map<string, Session>();

  constructor(private readonly config: OidcConfig) {}

  get enabled() {
    return Boolean(this.config.providerUrl && this.config.clientId && this.config.clientSecret);
  }

  get clientId() {
    return this.config.clientId;
  }

  async loginUrl(redirectUri: string, returnTo: string): Promise<string> {
    const metadata = await this.getMetadata();
    const state = randomUrlSafe(32);
    const verifier = randomUrlSafe(48);
    this.states.set(state, { verifier, returnTo, expiresAt: Date.now() + STATE_TTL_MS });
    this.prune();
    const challenge = crypto.createHash('sha256').update(verifier).digest('base64url');
    const url = new URL(metadata.authorization_endpoint);
    url.search = new URLSearchParams({
      response_type: 'code',
      client_id: this.config.clientId,
      redirect_uri: redirectUri,
      state,
      code_challenge: challenge,
      code_challenge_method: 'S256',
      scope: 'openid profile email',
    }).toString();
    return url.toString();
  }

  async completeLogin(code: string, state: string, redirectUri: string): Promise<{ returnTo: string; cookie: string }> {
    const loginState = this.states.get(state);
    this.states.delete(state);
    if (!loginState || loginState.expiresAt <= Date.now()) throw new Error('OIDC login state is invalid or expired');

    const metadata = await this.getMetadata();
    const response = await fetch(metadata.token_endpoint, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        grant_type: 'authorization_code',
        code,
        client_id: this.config.clientId,
        client_secret: this.config.clientSecret,
        redirect_uri: redirectUri,
        code_verifier: loginState.verifier,
      }),
    });
    if (!response.ok) throw new Error(`OIDC token exchange failed: ${response.status}`);
    const tokens = (await response.json()) as { access_token?: string; expires_in?: number };
    if (!tokens.access_token) throw new Error('OIDC token response did not include an access token');

    const userResponse = await fetch(metadata.userinfo_endpoint, {
      headers: { authorization: `Bearer ${tokens.access_token}`, 'x-auth-audience': this.config.clientId },
    });
    if (!userResponse.ok) throw new Error(`OIDC userinfo request failed: ${userResponse.status}`);
    const userInfo = (await userResponse.json()) as OidcUser & { sub?: string };
    const user = { ...userInfo, id: userInfo.id || userInfo.sub || '' };
    if (!user.id) throw new Error('OIDC userinfo response did not include a user id');

    const sessionToken = randomUrlSafe(32);
    const now = Date.now();
    this.sessions.set(sessionToken, {
      user,
      accessToken: tokens.access_token,
      accessTokenExpiresAt: now + Math.max(60, Number(tokens.expires_in || 900)) * 1000,
      expiresAt: now + SESSION_TTL_MS,
    });
    this.prune();
    return {
      returnTo: loginState.returnTo,
      cookie: `${SESSION_COOKIE}=${sessionToken}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${SESSION_TTL_MS / 1000}`,
    };
  }

  userFromCookie(cookieHeader: string | undefined): OidcUser | undefined {
    const session = this.sessionFromCookie(cookieHeader);
    return session?.user;
  }

  accessTokenFromCookie(cookieHeader: string | undefined) {
    const session = this.sessionFromCookie(cookieHeader);
    if (!session || session.accessTokenExpiresAt <= Date.now()) return undefined;
    return { accessToken: session.accessToken, expiresAt: session.accessTokenExpiresAt };
  }

  async scopesForToken(token: string): Promise<string[] | null> {
    try {
      const response = await fetch(new URL('/oauth/introspect', this.config.providerUrl.replace(/\/$/, '') + '/'), {
        method: 'POST',
        headers: {
          authorization: `Basic ${Buffer.from(`${this.config.clientId}:${this.config.clientSecret}`).toString('base64')}`,
          'content-type': 'application/x-www-form-urlencoded',
        },
        body: new URLSearchParams({ token, token_type_hint: 'access_token' }),
      });
      if (!response.ok) return null;
      const result = (await response.json()) as { active?: boolean; scope?: string | string[]; scopes?: string[] };
      if (!result.active) return null;
      return result.scopes || (Array.isArray(result.scope) ? result.scope : result.scope?.split(/\s+/).filter(Boolean) || []);
    } catch {
      return null;
    }
  }

  async tokenApiRequest(cookieHeader: string | undefined, path: string, init: RequestInit = {}, accessToken?: string) {
    const session = this.sessionFromCookie(cookieHeader);
    const bearer = accessToken || session?.accessToken;
    if (!bearer) return undefined;
    const headers = new Headers(init.headers);
    headers.set('authorization', `Bearer ${bearer}`);
    headers.set('x-auth-audience', this.config.clientId);
    return fetch(new URL(path, this.config.providerUrl.replace(/\/$/, '') + '/'), { ...init, headers });
  }

  clearCookie(cookieHeader: string | undefined) {
    const token = this.cookieToken(cookieHeader);
    if (token) this.sessions.delete(token);
    return `${SESSION_COOKIE}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0`;
  }

  private sessionFromCookie(cookieHeader: string | undefined) {
    const token = this.cookieToken(cookieHeader);
    if (!token) return undefined;
    const session = this.sessions.get(token);
    if (!session || session.expiresAt <= Date.now()) {
      this.sessions.delete(token);
      return undefined;
    }
    return session;
  }

  private cookieToken(cookieHeader: string | undefined) {
    return cookieHeader
      ?.split(';')
      .map((part) => part.trim().split('='))
      .find(([name]) => name === SESSION_COOKIE)?.[1];
  }

  private async getMetadata(): Promise<OidcMetadata> {
    if (this.metadata) return this.metadata;
    const response = await fetch(new URL('/.well-known/openid-configuration', `${this.config.providerUrl.replace(/\/$/, '')}/`));
    if (!response.ok) throw new Error(`OIDC discovery failed: ${response.status}`);
    this.metadata = (await response.json()) as OidcMetadata;
    return this.metadata;
  }

  private prune() {
    const now = Date.now();
    for (const [key, state] of this.states) if (state.expiresAt <= now) this.states.delete(key);
    for (const [key, session] of this.sessions) if (session.expiresAt <= now) this.sessions.delete(key);
  }
}

function randomUrlSafe(bytes: number) {
  return crypto.randomBytes(bytes).toString('base64url');
}
