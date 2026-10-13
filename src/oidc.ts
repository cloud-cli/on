import crypto from "node:crypto";
import {
  ClientSecretBasic,
  ClientSecretPost,
  Configuration,
  authorizationCodeGrant,
  buildAuthorizationUrl,
  discovery,
  fetchUserInfo,
  refreshTokenGrant,
  skipSubjectCheck,
  tokenIntrospection,
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
  email_verified?: boolean;
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
  accessToken: string;
  refreshToken?: string;
  accessTokenExpiresAt: number;
  expiresAt: number;
  refreshPromise?: Promise<boolean>;
}

const STATE_TTL_MS = 10 * 60 * 1000;
const SESSION_TTL_MS = 8 * 60 * 60 * 1000;
const SESSION_COOKIE = "runner_oidc_session";

export class OidcClient {
  private configurationPromise?: Promise<Configuration>;
  private introspectionConfigurationPromise?: Promise<Configuration>;
  private authApiClientPromise?: Promise<any>;
  private readonly sessions = new Map<string, Session>();
  private readonly config: OidcConfig;

  constructor(config: OidcConfig) {
    this.config = { ...config, providerUrl: normalizeIssuer(config.providerUrl) };
  }

  get enabled() {
    return Boolean(this.config.providerUrl && this.config.clientId && this.config.clientSecret);
  }

  get providerUrl() {
    return this.config.providerUrl;
  }

  get clientId() {
    return this.config.clientId;
  }

  private getConfiguration() {
    if (!this.configurationPromise) {
      this.configurationPromise = discovery(
        new URL(this.config.providerUrl),
        this.config.clientId,
        undefined,
        ClientSecretPost(this.config.clientSecret),
      );
    }
    return this.configurationPromise;
  }

  private getIntrospectionConfiguration() {
    if (!this.introspectionConfigurationPromise) {
      this.introspectionConfigurationPromise = this.getConfiguration().then((config) => {
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
    return this.introspectionConfigurationPromise;
  }

  async loginUrl(redirectUri: string, returnTo: string): Promise<string> {
    const config = await this.getConfiguration();
    const verifier = randomUrlSafe(32);
    const challenge = crypto.createHash("sha256").update(verifier).digest("base64url");
    const state = this.signState({
      verifier,
      nonce: randomUrlSafe(16),
      returnTo,
      expiresAt: Date.now() + STATE_TTL_MS,
    });
    return buildAuthorizationUrl(config, {
      redirect_uri: redirectUri,
      scope: "openid profile email offline_access",
      code_challenge: challenge,
      code_challenge_method: "S256",
      state,
      nonce: this.parseState(state).nonce,
    }).href;
  }

  async completeLogin(code: string, state: string, redirectUri: string): Promise<{ returnTo: string; cookie: string }> {
    const loginState = this.parseState(state);
    if (loginState.expiresAt <= Date.now()) {
      throw new Error("OIDC login state is invalid or expired");
    }

    const config = await this.getConfiguration();
    const callbackUrl = new URL(redirectUri);
    callbackUrl.searchParams.set("code", code);
    callbackUrl.searchParams.set("state", state);
    const tokens = await authorizationCodeGrant(config, callbackUrl, {
      expectedState: state,
      expectedNonce: loginState.nonce,
      pkceCodeVerifier: loginState.verifier,
    });
    if (!tokens.access_token) {
      throw new Error("OIDC token response did not include an access token");
    }

    const claims = tokens.claims();
    const subject = claims?.sub;
    if (typeof subject !== "string" || !subject) {
      throw new Error("OIDC ID token did not include a user id");
    }
    const userInfo = await fetchUserInfo(config, tokens.access_token, subject);
    const user = normalizeUser(userInfo);
    if (user.id !== subject) {
      throw new Error("OIDC userinfo subject did not match the ID token");
    }

    const sessionToken = randomUrlSafe(32);
    const now = Date.now();
    this.sessions.set(sessionToken, {
      user,
      accessToken: tokens.access_token,
      refreshToken: tokens.refresh_token,
      accessTokenExpiresAt: now + Number(tokens.expires_in || 900) * 1000,
      expiresAt: now + SESSION_TTL_MS,
    });
    this.prune();
    return {
      returnTo: loginState.returnTo,
      cookie: `${SESSION_COOKIE}=${sessionToken}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${SESSION_TTL_MS / 1000}`,
    };
  }

  userFromCookie(cookieHeader: string | undefined): OidcUser | undefined {
    return this.sessionFromCookie(cookieHeader)?.user;
  }

  async userFromAccessToken(accessToken: string): Promise<OidcUser | undefined> {
    if (!accessToken || accessToken.length > 16_384) {
      return undefined;
    }
    try {
      const userInfo = await fetchUserInfo(await this.getConfiguration(), accessToken, skipSubjectCheck);
      const user = normalizeUser(userInfo);
      return user.id ? user : undefined;
    } catch {
      return undefined;
    }
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
    if (session.accessTokenExpiresAt > Date.now() + 30_000) {
      return { accessToken: session.accessToken, expiresAt: session.accessTokenExpiresAt };
    }
    if (!session.refreshToken || !(await this.refreshSessionToken(session))) {
      if (cookieToken) {
        this.sessions.delete(cookieToken);
      }
      return undefined;
    }
    return { accessToken: session.accessToken, expiresAt: session.accessTokenExpiresAt };
  }

  private refreshSessionToken(session: Session) {
    if (!session.refreshPromise) {
      session.refreshPromise = this.requestTokenRefresh(session).finally(() => {
        session.refreshPromise = undefined;
      });
    }
    return session.refreshPromise;
  }

  private async requestTokenRefresh(session: Session) {
    try {
      const tokens = await refreshTokenGrant(await this.getConfiguration(), session.refreshToken!);
      if (!tokens.access_token || !tokens.expires_in) {
        throw new Error("OIDC token refresh response was incomplete");
      }
      session.accessToken = tokens.access_token;
      session.refreshToken = tokens.refresh_token || session.refreshToken;
      session.accessTokenExpiresAt = Date.now() + Number(tokens.expires_in) * 1000;
      return true;
    } catch (error) {
      const status = (error as { status?: number }).status;
      if (status === 400 || status === 401) {
        return false;
      }
      throw error;
    }
  }

  async scopesForToken(token: string): Promise<string[] | null> {
    try {
      const result = await tokenIntrospection(await this.getIntrospectionConfiguration(), token);
      if (!result.active) {
        return null;
      }
      return typeof result.scope === "string" ? result.scope.split(/\s+/).filter(Boolean) : [];
    } catch {
      return null;
    }
  }

  async tokenApiRequest(cookieHeader: string | undefined, path: string, init: RequestInit = {}, accessToken?: string) {
    const session = this.sessionFromCookie(cookieHeader);
    const bearer = accessToken || session?.accessToken;
    if (!bearer) {
      return undefined;
    }
    const client = await this.authApiClient();
    const headers = new Headers(init.headers);
    headers.set("authorization", `Bearer ${bearer}`);
    headers.set("x-auth-audience", this.config.clientId);
    const contentType = headers.get("content-type") || "";
    let body: unknown;
    if (typeof init.body === "string") {
      body = contentType.includes("application/json") ? JSON.parse(init.body) : init.body;
    } else {
      body = init.body;
    }
    try {
      const result = await client.request(path, {
        method: init.method || "GET",
        headers: Object.fromEntries(headers.entries()),
        body,
      });
      return new Response(JSON.stringify(result), { status: 200, headers: { "content-type": "application/json" } });
    } catch (error) {
      const status = (error as { status?: number }).status;
      const message = error instanceof Error ? error.message : "Auth API request failed";
      return new Response(JSON.stringify({ error: message }), {
        status: status && status >= 400 && status <= 599 ? status : 502,
        headers: { "content-type": "application/json" },
      });
    }
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

  private async authApiClient() {
    if (!this.authApiClientPromise) {
      const moduleUrl = new URL("/node.mjs", `${this.config.providerUrl}/`);
      this.authApiClientPromise = fetch(moduleUrl).then(async (response) => {
        if (!response.ok) {
          throw new Error(`Auth API module failed: ${response.status}`);
        }
        const source = await response.text();
        const module = await import(`data:text/javascript;base64,${Buffer.from(source).toString("base64")}`);
        return module.createAuthClient({ issuer: this.config.providerUrl, clientId: this.config.clientId });
      });
    }
    return this.authApiClientPromise;
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
    if (!state.verifier || !state.nonce || !state.returnTo || !Number.isFinite(state.expiresAt)) {
      throw new Error("OIDC login state is invalid or expired");
    }
    return state;
  }
}

function normalizeUser(userInfo: Record<string, unknown>): OidcUser {
  const id = typeof userInfo.sub === "string" ? userInfo.sub : typeof userInfo.id === "string" ? userInfo.id : "";
  return {
    ...userInfo,
    id,
    name: (userInfo.name as string | undefined) || (userInfo.preferred_username as string | undefined),
    photo: (userInfo.photo as string | undefined) || (userInfo.picture as string | undefined),
  } as OidcUser;
}

function randomUrlSafe(bytes: number) {
  return crypto.randomBytes(bytes).toString("base64url");
}

function normalizeIssuer(value: string) {
  return value.replace(/\/api\/?$/, "").replace(/\/$/, "");
}
