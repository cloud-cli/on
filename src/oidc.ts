import crypto from "node:crypto";
import {
  ClientSecretBasic,
  Configuration,
  buildAuthorizationUrl,
  authorizationCodeGrant,
  fetchUserInfo,
  refreshTokenGrant,
  tokenIntrospection,
  discovery,
  ClientSecretPost,
} from "openid-client";

export interface OidcConfig {
  providerUrl: string;
  clientId: string;
  clientSecret: string;
}

export interface OidcUser {
  id: string;
  name?: string;
  email?: string;
  photo?: string;
  preferred_username?: string;
  picture?: string;
  role?: string;
}

interface LoginState {
  verifier: string;
  nonce: string;
  returnTo: string;
  expiresAt: number;
}

interface Session {
  user: OidcUser;
  role?: "user" | "admin";
  tokens: { access_token: string; refresh_token: string; expires_at: number };
  expiresAt: number;
  refreshPromise?: Promise<boolean>;
}

const STATE_TTL_MS = 10 * 60 * 1000;
const SESSION_TTL_MS = 8 * 60 * 60 * 1000;
const SESSION_COOKIE = "runner_oidc_session";

export class OidcClient {
  private configPromise?: Promise<Configuration>;
  private introspectionConfigPromise?: Promise<Configuration>;
  private readonly sessions = new Map<string, Session>();

  constructor(config: OidcConfig) {
    this.config = { ...config, providerUrl: normalizeIssuer(config.providerUrl) };
  }

  private readonly config: OidcConfig;

  get enabled() {
    return Boolean(this.config.providerUrl && this.config.clientId && this.config.clientSecret);
  }

  get providerUrl() {
    return this.config.providerUrl;
  }

  get clientId() {
    return this.config.clientId;
  }

  private async getConfiguration(): Promise<Configuration> {
    if (!this.configPromise) {
      this.configPromise = discovery(
        new URL(this.config.providerUrl),
        this.config.clientId,
        undefined,
        ClientSecretPost(this.config.clientSecret),
      );
    }
    return this.configPromise;
  }

  private async getIntrospectionConfiguration(): Promise<Configuration> {
    if (!this.introspectionConfigPromise) {
      this.introspectionConfigPromise = this.getConfiguration().then((config) => {
        const { supportsPKCE: _supportsPKCE, ...serverMetadata } = config.serverMetadata();
        return new Configuration(
          {
            ...serverMetadata,
            introspection_endpoint: new URL("/oauth/introspect", this.config.providerUrl).href,
          },
          this.config.clientId,
          undefined,
          ClientSecretBasic(this.config.clientSecret),
        );
      });
    }
    return this.introspectionConfigPromise;
  }

  async loginUrl(redirectUri: string, returnTo: string): Promise<string> {
    const config = await this.getConfiguration();
    const codeVerifier = crypto.randomBytes(32).toString("base64url");
    const codeChallenge = crypto.createHash("sha256").update(codeVerifier).digest("base64url");
    const nonce = randomUrlSafe(16);
    const state = this.signState({ verifier: codeVerifier, nonce, returnTo, expiresAt: Date.now() + STATE_TTL_MS });
    const authorizationUrl = buildAuthorizationUrl(config, {
      redirect_uri: redirectUri,
      scope: "openid profile email offline_access",
      code_challenge: codeChallenge,
      code_challenge_method: "S256",
      state,
      nonce,
    });
    return authorizationUrl.href;
  }

  async completeLogin(code: string, state: string, redirectUri: string): Promise<{ returnTo: string; cookie: string }> {
    const loginState = this.parseState(state);
    if (!loginState || loginState.expiresAt <= Date.now()) {
      throw new Error("OIDC login state is invalid or expired");
    }

    const config = await this.getConfiguration();
    const callbackUrl = new URL(redirectUri);
    callbackUrl.searchParams.set("code", code);
    callbackUrl.searchParams.set("state", state);
    const tokenResponse = await authorizationCodeGrant(config, callbackUrl, {
      expectedState: state,
      expectedNonce: loginState.nonce,
      pkceCodeVerifier: loginState.verifier,
    });
    if (!tokenResponse.access_token) {
      throw new Error("OIDC token response did not include an access token");
    }
    if (!tokenResponse.refresh_token) {
      throw new Error("OIDC token response did not include a refresh token for offline_access");
    }
    const subject = tokenResponse.claims()?.sub;
    if (typeof subject !== "string" || !subject) {
      throw new Error("OIDC ID token did not include a user id");
    }
    const userInfo = await fetchUserInfo(config, tokenResponse.access_token, subject);
    if (!userInfo || typeof userInfo !== "object") {
      throw new Error("OIDC userinfo response was empty");
    }
    const user = {
      ...userInfo,
      id: typeof userInfo.sub === "string" ? userInfo.sub : userInfo.id || "",
      name: userInfo.name || userInfo.preferred_username,
      photo: userInfo.photo || userInfo.picture,
    } as OidcUser;
    if (user.id !== subject) {
      throw new Error("OIDC userinfo subject did not match the ID token");
    }

    const sessionToken = randomUrlSafe(32);
    const now = Date.now();
    this.sessions.set(sessionToken, {
      user,
      tokens: {
        access_token: tokenResponse.access_token!,
        refresh_token: tokenResponse.refresh_token!,
        expires_at: Math.floor((now + Number(tokenResponse.expires_in || 900) * 1000) / 1000),
      },
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

  setRole(cookieHeader: string, role: "user" | "admin") {
    const token = this.cookieToken(cookieHeader);
    const session = token ? this.sessions.get(token) : undefined;
    if (session) {
      session.role = role;
    }
  }

  setRoleForUser(subject: string, role: "user" | "admin") {
    for (const session of this.sessions.values()) {
      if (session.user.id === subject) {
        session.role = role;
      }
    }
  }

  roleFromCookie(cookieHeader: string | undefined) {
    return this.sessionFromCookie(cookieHeader)?.role;
  }

  async accessTokenFromCookie(cookieHeader: string | undefined) {
    const cookieToken = this.cookieToken(cookieHeader);
    const session = this.sessionFromCookie(cookieHeader);
    if (!session) {
      return undefined;
    }
    if (session.tokens.expires_at > Math.floor(Date.now() / 1000) + 30) {
      return { accessToken: session.tokens.access_token, expiresAt: session.tokens.expires_at * 1000 };
    }
    if (!session.tokens.refresh_token || !(await this.refreshSessionToken(session))) {
      if (cookieToken) {
        this.sessions.delete(cookieToken);
      }
      return undefined;
    }
    return { accessToken: session.tokens.access_token, expiresAt: session.tokens.expires_at * 1000 };
  }

  private async refreshSessionToken(session: Session) {
    if (!session.refreshPromise) {
      session.refreshPromise = this.requestTokenRefresh(session).finally(() => {
        session.refreshPromise = undefined;
      });
    }
    return session.refreshPromise;
  }

  private async requestTokenRefresh(session: Session) {
    try {
      const config = await this.getConfiguration();
      const tokenResponse = await refreshTokenGrant(config, session.tokens.refresh_token!);
      if (!tokenResponse.access_token || !tokenResponse.refresh_token || !tokenResponse.expires_in) {
        throw new Error("OIDC token refresh response was incomplete");
      }
      session.tokens = {
        access_token: tokenResponse.access_token,
        refresh_token: tokenResponse.refresh_token,
        expires_at: Math.floor((Date.now() + Number(tokenResponse.expires_in) * 1000) / 1000),
      };
      return true;
    } catch (error: any) {
      if (error.status === 400 || error.status === 401) {
        return false;
      }
      throw error;
    }
  }

  async scopesForToken(token: string): Promise<string[] | null> {
    try {
      const config = await this.getIntrospectionConfiguration();
      const result = await tokenIntrospection(config, token);
      if (!result.active) {
        return null;
      }
      return result.scope
        ? Array.isArray(result.scope)
          ? result.scope
          : result.scope.split(/\s+/).filter(Boolean)
        : [];
    } catch {
      return null;
    }
  }

  async tokenApiRequest(cookieHeader: string | undefined, path: string, init: RequestInit = {}, accessToken?: string) {
    const session = this.sessionFromCookie(cookieHeader);
    const bearer = accessToken || session?.tokens.access_token;
    if (!bearer) {
      return undefined;
    }
    const headers = new Headers(init.headers);
    headers.set("authorization", `Bearer ${bearer}`);
    headers.set("x-auth-audience", this.config.clientId);
    return fetch(new URL(path, this.config.providerUrl.replace(/\/$/, "") + "/"), { ...init, headers });
  }

  clearCookie(cookieHeader: string | undefined) {
    const token = this.cookieToken(cookieHeader);
    if (token) {
      this.sessions.delete(token);
    }
    return `${SESSION_COOKIE}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0`;
  }

  private sessionFromCookie(cookieHeader: string | undefined) {
    const token = this.cookieToken(cookieHeader);
    if (!token) {
      return undefined;
    }
    const session = this.sessions.get(token);
    if (!session || session.expiresAt <= Date.now()) {
      this.sessions.delete(token);
      return undefined;
    }
    return session;
  }

  private cookieToken(cookieHeader: string | undefined) {
    return cookieHeader
      ?.split(";")
      .map((part) => part.trim().split("="))
      .find(([name]) => name === SESSION_COOKIE)?.[1];
  }

  private prune() {
    const now = Date.now();
    for (const [key, session] of this.sessions) {
      if (session.expiresAt <= now) {
        this.sessions.delete(key);
      }
    }
  }

  private signState(state: LoginState) {
    const payload = Buffer.from(JSON.stringify(state)).toString("base64url");
    const signature = crypto.createHmac("sha256", this.config.clientSecret).update(payload).digest("base64url");
    return `${payload}.${signature}`;
  }

  private parseState(value: string): LoginState {
    const [payload, signature] = value.split(".");
    if (!payload || !signature) {
      throw new Error("OIDC login state is invalid or expired");
    }
    const expected = crypto.createHmac("sha256", this.config.clientSecret).update(payload).digest("base64url");
    const valid =
      signature.length === expected.length && crypto.timingSafeEqual(Buffer.from(signature), Buffer.from(expected));
    if (!valid) {
      throw new Error("OIDC login state is invalid or expired");
    }
    const state = JSON.parse(Buffer.from(payload, "base64url").toString("utf8")) as LoginState;
    if (!state.verifier || !state.nonce || !state.returnTo || state.expiresAt <= Date.now()) {
      throw new Error("OIDC login state is invalid or expired");
    }
    return state;
  }
}

function normalizeIssuer(url: string): string {
  try {
    const u = new URL(url);
    u.pathname = u.pathname.replace(/\/+$/, "");
    return u.toString().replace(/\/$/, "");
  } catch {
    return url.replace(/\/+$/, "");
  }
}

function randomUrlSafe(bytes: number): string {
  return crypto.randomBytes(bytes).toString("base64url");
}
