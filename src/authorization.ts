import type http from "node:http";
import type { OidcClient } from "./oidc.js";
import type { Principal, PrincipalRepository } from "./principals.js";
import {
  WORKSPACE_CAPABILITIES,
  isGlobalCapability,
  isWorkspaceCapability,
  LEGACY_SCOPE_CAPABILITIES,
  type GlobalCapability,
  type WorkspaceCapability,
} from "./permissions.js";

export type AuthSource = "session" | "token";
export type AuthContext = { principal: Principal; source: AuthSource };
export type AuthFailure = { status: number; error: string };

export type WorkspaceAuthorization = {
  principal: Principal;
  source: AuthSource;
  teamId: string;
  role: string;
  capabilities: WorkspaceCapability[];
};

function bearerToken(req: http.IncomingMessage): string | undefined {
  const authorization = req.headers.authorization || "";
  return authorization.startsWith("Bearer ") ? authorization.slice(7) : undefined;
}

function requestedTeamId(req: http.IncomingMessage, override?: string): string {
  if (override) {
    return override;
  }
  const header = typeof req.headers["x-workspace-id"] === "string" ? req.headers["x-workspace-id"].trim() : "";
  if (header) {
    return header;
  }
  return new URL(req.url || "/", "http://localhost").searchParams.get("teamId")?.trim() || "";
}

function isMutation(req: http.IncomingMessage): boolean {
  return !["GET", "HEAD", "OPTIONS"].includes((req.method || "GET").toUpperCase());
}

function sameOrigin(req: http.IncomingMessage): boolean {
  const origin = req.headers.origin;
  if (!origin) {
    return false;
  }
  try {
    const parsed = new URL(origin);
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
      return false;
    }
    return (
      parsed.host.toLowerCase() ===
      String(req.headers.host || "")
        .trim()
        .toLowerCase()
    );
  } catch {
    return false;
  }
}

export function deny(res: http.ServerResponse, status: number, error: string): void {
  if (res.headersSent) {
    return;
  }
  res.writeHead(status, { "Cache-Control": "no-store", "Content-Type": "application/json; charset=utf-8" });
  res.end(JSON.stringify({ error }));
}

/**
 * Resolve exactly one live principal per request.
 *
 * A browser session and a bearer credential may both be present because the
 * browser client forwards its provider access token. They must resolve to the
 * same principal; anything else is rejected instead of silently choosing one.
 */
export class RequestAuthorizer {
  constructor(
    private readonly oidc: OidcClient | undefined,
    private readonly principals: PrincipalRepository,
  ) {}

  async resolve(req: http.IncomingMessage): Promise<AuthContext | AuthFailure> {
    const sessionUser = this.oidc?.userFromCookie(req.headers.cookie);
    const bearer = bearerToken(req);

    if (sessionUser) {
      if (bearer) {
        const bearerPrincipal = await this.principalForBearer(bearer);
        if ("status" in bearerPrincipal) {
          return bearerPrincipal;
        }
        if (bearerPrincipal.subject !== sessionUser.id) {
          return { status: 403, error: "Session and bearer credential identify different principals" };
        }
      }
      const principal = await this.principals.principal(sessionUser.id);
      if (!principal || principal.disabled) {
        return { status: 401, error: "Authentication required" };
      }
      return { principal, source: "session" };
    }

    if (!bearer) {
      return { status: 401, error: "Authentication required" };
    }
    const principal = await this.principalForBearer(bearer);
    if ("status" in principal) {
      return principal;
    }
    return { principal, source: "token" };
  }

  private async principalForBearer(token: string): Promise<Principal | AuthFailure> {
    const principal = await this.principals.tokenPrincipal(token);
    if (principal) {
      return principal;
    }
    const oidcUser = await this.oidc?.userFromAccessToken(token);
    const opaqueIdentity = oidcUser ? undefined : await this.oidc?.identityForToken(token);
    const subject = oidcUser?.id || opaqueIdentity?.subject;
    if (!subject) {
      return { status: 401, error: "Bearer credential is invalid or revoked" };
    }
    const resolved = await this.principals.principal(subject);
    if (!resolved || resolved.disabled) {
      return { status: 401, error: "Authentication required" };
    }
    return resolved;
  }

  async authenticated(req: http.IncomingMessage, res: http.ServerResponse): Promise<AuthContext | null> {
    const resolved = await this.resolve(req);
    if ("status" in resolved) {
      deny(res, resolved.status, resolved.error);
      return null;
    }
    if (resolved.source === "session" && isMutation(req) && !sameOrigin(req)) {
      deny(res, 403, "Same-origin request required");
      return null;
    }
    return resolved;
  }

  async human(req: http.IncomingMessage, res: http.ServerResponse): Promise<AuthContext | null> {
    const context = await this.authenticated(req, res);
    if (!context) {
      return null;
    }
    if (context.principal.kind !== "human") {
      deny(res, 403, "This action requires an interactive human session");
      return null;
    }
    return context;
  }

  async workspace(
    req: http.IncomingMessage,
    res: http.ServerResponse,
    capability: WorkspaceCapability,
    teamIdOverride?: string,
  ): Promise<WorkspaceAuthorization | null> {
    const context = await this.authenticated(req, res);
    if (!context) {
      return null;
    }
    const teamId = requestedTeamId(req, teamIdOverride);
    if (!teamId) {
      deny(res, 400, "X-Workspace-ID is required");
      return null;
    }
    if (await this.hasOidcAdmin(req, context.principal)) {
      return {
        principal: context.principal,
        source: context.source,
        teamId,
        role: "admin",
        capabilities: [...WORKSPACE_CAPABILITIES],
      };
    }
    const membership = await this.principals.membership(teamId, context.principal.subject);
    if (!membership) {
      deny(res, 404, "Workspace not found");
      return null;
    }
    if (!membership.capabilities.includes(capability)) {
      deny(res, 403, `Missing required capability: ${capability}`);
      return null;
    }
    return {
      principal: context.principal,
      source: context.source,
      teamId,
      role: membership.role,
      capabilities: membership.capabilities,
    };
  }

  async platform(
    req: http.IncomingMessage,
    res: http.ServerResponse,
    capability: GlobalCapability,
  ): Promise<AuthContext | null> {
    const context = await this.authenticated(req, res);
    if (!context) {
      return null;
    }
    if (await this.hasOidcAdmin(req, context.principal)) {
      return context;
    }
    if (!context.principal.platformCapabilities.includes(capability)) {
      deny(res, 403, `Missing required capability: ${capability}`);
      return null;
    }
    return context;
  }

  /** Require any one of several platform capabilities, for mixed administration pages. */
  async platformAny(
    req: http.IncomingMessage,
    res: http.ServerResponse,
    capabilities: readonly GlobalCapability[],
  ): Promise<AuthContext | null> {
    const context = await this.authenticated(req, res);
    if (!context) {
      return null;
    }
    if (await this.hasOidcAdmin(req, context.principal)) {
      return context;
    }
    if (!capabilities.some((capability) => context.principal.platformCapabilities.includes(capability))) {
      deny(res, 403, "Missing required platform capability");
      return null;
    }
    return context;
  }

  async hasOidcAdmin(req: http.IncomingMessage, principal: Principal): Promise<boolean> {
    const token = bearerToken(req);
    if (!token || !this.oidc) {
      return false;
    }
    const identity = await this.oidc.identityForToken(token);
    return Boolean(identity && identity.subject === principal.subject && identity.scopes.includes("admin"));
  }

  /**
   * Translate a legacy scope name to its canonical capability. Legacy workspace
   * keys are disabled; this only keeps old scope labels working in routes that
   * still accept them from a principal.
   */
  async legacyScope(
    req: http.IncomingMessage,
    res: http.ServerResponse,
    scope: string,
  ): Promise<WorkspaceAuthorization | AuthContext | null> {
    const capability = LEGACY_SCOPE_CAPABILITIES[scope];
    if (!capability) {
      deny(res, 403, `Unknown capability for legacy scope: ${scope}`);
      return null;
    }
    if (isGlobalCapability(capability)) {
      return this.platform(req, res, capability);
    }
    if (isWorkspaceCapability(capability)) {
      return this.workspace(req, res, capability);
    }
    deny(res, 403, `Unknown capability for legacy scope: ${scope}`);
    return null;
  }
}
