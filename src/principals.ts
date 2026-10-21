import crypto from "node:crypto";
import db from "./db-client.js";
import {
  effectiveCapabilitiesFor,
  elevatedOverrides,
  globalCapabilitiesForRole,
  isWorkspaceCapability,
  isWorkspaceRole,
  roleFromLegacyMemberRole,
  sanitizeSystemUserOverrides,
  sanitizeWorkspaceOverrides,
  type GlobalCapability,
  type PermissionOverride,
  type WorkspaceCapability,
  type WorkspaceRole,
} from "./permissions.js";

const opaque = (bytes = 32) => crypto.randomBytes(bytes).toString("base64url");
const digest = (value: string) => crypto.createHash("sha256").update(value).digest("hex");

export type PrincipalKind = "human" | "system";
export type PlatformRole = "user" | "admin";

export type Principal = {
  subject: string;
  kind: PrincipalKind;
  name?: string;
  email?: string;
  photo?: string;
  platformRole: PlatformRole;
  platformCapabilities: GlobalCapability[];
  disabled: boolean;
};

export type PrincipalToken = {
  id: string;
  subject: string;
  name: string;
  createdAt: string;
  lastUsedAt: string | null;
};

export type WorkspaceMembership = {
  teamId: string;
  subject: string;
  role: WorkspaceRole;
  overrides: PermissionOverride[];
  capabilities: WorkspaceCapability[];
};

export type WorkspaceMemberView = {
  subject: string;
  name?: string;
  email?: string;
  kind: PrincipalKind;
  role: WorkspaceRole;
  overrides: PermissionOverride[];
  capabilities: WorkspaceCapability[];
  disabled: boolean;
};

export function memberViewForCaller(member: WorkspaceMemberView, canManage: boolean): Partial<WorkspaceMemberView> {
  if (canManage) {
    return member;
  }
  return { name: member.name, kind: member.kind, role: member.role, disabled: member.disabled };
}

function normalizePrincipal(row: any): Principal {
  const kind: PrincipalKind = row.kind === "system" ? "system" : "human";
  const platformRole: PlatformRole = kind === "system" ? "user" : row.role === "admin" ? "admin" : "user";
  return {
    subject: row.subject,
    kind,
    name: row.name || undefined,
    email: row.email || undefined,
    photo: row.photo || undefined,
    platformRole,
    platformCapabilities: globalCapabilitiesForRole(platformRole),
    disabled: Boolean(row.disabled_at),
  };
}

/**
 * Directory of humans and system users, workspace memberships, sparse
 * permission overrides, and principal-bound tokens.
 *
 * Authorization reads this state live on every request so revocation and role
 * changes take effect immediately, even across server instances.
 */
export class PrincipalRepository {
  async init(): Promise<void> {
    await db.exec(`
      CREATE TABLE IF NOT EXISTS workspace_permission_overrides (
        team_id TEXT NOT NULL REFERENCES teams(id) ON DELETE CASCADE,
        subject TEXT NOT NULL REFERENCES oidc_users(subject) ON DELETE CASCADE,
        capability TEXT NOT NULL,
        effect TEXT NOT NULL CHECK(effect IN ('allow','deny')),
        granted_by TEXT,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        PRIMARY KEY(team_id, subject, capability)
      );
      CREATE TABLE IF NOT EXISTS principal_tokens (
        id TEXT PRIMARY KEY,
        subject TEXT NOT NULL REFERENCES oidc_users(subject) ON DELETE CASCADE,
        name TEXT NOT NULL,
        token_hash TEXT NOT NULL UNIQUE,
        created_by TEXT NOT NULL,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        last_used_at DATETIME,
        revoked_at DATETIME
      );
      CREATE TABLE IF NOT EXISTS authorization_audit (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        actor TEXT,
        action TEXT NOT NULL,
        target TEXT,
        team_id TEXT,
        detail TEXT,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP
      );
    `);
  }

  async recordAudit(entry: {
    actor?: string | null;
    action: string;
    target?: string | null;
    teamId?: string | null;
    detail?: unknown;
  }): Promise<void> {
    await db.run("INSERT INTO authorization_audit (actor, action, target, team_id, detail) VALUES (?, ?, ?, ?, ?)", [
      entry.actor || null,
      entry.action,
      entry.target || null,
      entry.teamId || null,
      entry.detail === undefined ? null : JSON.stringify(entry.detail),
    ]);
  }

  async principal(subject: string): Promise<Principal | null> {
    const row = await db.get(
      "SELECT subject, name, email, photo, role, kind, disabled_at FROM oidc_users WHERE subject = ?",
      [subject],
    );
    return row ? normalizePrincipal(row) : null;
  }

  async tokenPrincipal(token: string): Promise<Principal | null> {
    if (!token || token.length > 200) {
      return null;
    }
    const row = await db.get(
      `SELECT t.id AS token_id, u.subject, u.name, u.email, u.photo, u.role, u.kind, u.disabled_at
       FROM principal_tokens t JOIN oidc_users u ON u.subject = t.subject
       WHERE t.token_hash = ? AND t.revoked_at IS NULL`,
      [digest(token)],
    );
    if (!row || row.disabled_at) {
      return null;
    }
    await db.run("UPDATE principal_tokens SET last_used_at = CURRENT_TIMESTAMP WHERE id = ?", [row.token_id]);
    return normalizePrincipal(row);
  }

  async listTokens(subject: string): Promise<PrincipalToken[]> {
    const rows = await db.all(
      `SELECT id, subject, name, created_at, last_used_at FROM principal_tokens
       WHERE subject = ? AND revoked_at IS NULL ORDER BY created_at DESC`,
      [subject],
    );
    return rows.map((row: any) => ({
      id: row.id,
      subject: row.subject,
      name: row.name,
      createdAt: row.created_at,
      lastUsedAt: row.last_used_at || null,
    }));
  }

  async listTokensForWorkspace(teamId: string): Promise<Array<PrincipalToken & { kind: PrincipalKind }>> {
    const rows = await db.all(
      `SELECT t.id, t.subject, t.name, t.created_at, t.last_used_at, u.kind
       FROM principal_tokens t
       JOIN oidc_users u ON u.subject = t.subject
       JOIN team_members m ON m.team_id = ? AND m.subject = t.subject
       WHERE t.revoked_at IS NULL
       ORDER BY t.created_at DESC`,
      [teamId],
    );
    return rows.map((row: any) => ({
      id: row.id,
      subject: row.subject,
      name: row.name,
      createdAt: row.created_at,
      lastUsedAt: row.last_used_at || null,
      kind: row.kind === "system" ? "system" : "human",
    }));
  }

  async issueToken(subject: string, name: string, createdBy: string) {
    const trimmed = name.trim();
    if (!trimmed || trimmed.length > 100) {
      throw new Error("Token name must be between 1 and 100 characters");
    }
    const principal = await this.principal(subject);
    if (!principal || principal.disabled) {
      throw new Error("Token owner is missing or disabled");
    }
    const token = `on_pat_${opaque(32)}`;
    const id = opaque(18);
    await db.run("INSERT INTO principal_tokens (id, subject, name, token_hash, created_by) VALUES (?, ?, ?, ?, ?)", [
      id,
      subject,
      trimmed,
      digest(token),
      createdBy,
    ]);
    await this.recordAudit({
      actor: createdBy,
      action: "token.issue",
      target: subject,
      detail: { tokenId: id, name: trimmed },
    });
    return { id, name: trimmed, subject, token };
  }

  async revokeToken(id: string, actor: string, teamId?: string): Promise<boolean> {
    const result = await db.run(
      "UPDATE principal_tokens SET revoked_at = CURRENT_TIMESTAMP WHERE id = ? AND revoked_at IS NULL",
      [id],
    );
    if (Number(result?.changes || 0) > 0) {
      await this.recordAudit({ actor, action: "token.revoke", target: id, teamId: teamId || null });
      return true;
    }
    return false;
  }

  async createSystemUser(input: { name: string; actor: string; email?: string }) {
    const name = input.name.trim();
    if (!name || name.length > 100) {
      throw new Error("System user name must be between 1 and 100 characters");
    }
    const subject = `system:${opaque(18)}`;
    await db.run(
      `INSERT INTO oidc_users (subject, name, email, role, kind, created_by)
       VALUES (?, ?, ?, 'user', 'system', ?)`,
      [subject, name, input.email?.trim() || null, input.actor],
    );
    await this.recordAudit({ actor: input.actor, action: "system-user.create", target: subject, detail: { name } });
    return (await this.principal(subject))!;
  }

  async updateSystemUser(
    subject: string,
    input: { name?: string; disabled?: boolean },
    actor: string,
  ): Promise<Principal | null> {
    const principal = await this.principal(subject);
    if (!principal || principal.kind !== "system") {
      return null;
    }
    if (input.name !== undefined) {
      const name = input.name.trim();
      if (!name || name.length > 100) {
        throw new Error("System user name must be between 1 and 100 characters");
      }
      await db.run("UPDATE oidc_users SET name = ?, updated_at = CURRENT_TIMESTAMP WHERE subject = ?", [name, subject]);
    }
    if (input.disabled !== undefined) {
      await db.run("UPDATE oidc_users SET disabled_at = ?, updated_at = CURRENT_TIMESTAMP WHERE subject = ?", [
        input.disabled ? new Date().toISOString() : null,
        subject,
      ]);
      if (input.disabled) {
        await db.run(
          "UPDATE principal_tokens SET revoked_at = CURRENT_TIMESTAMP WHERE subject = ? AND revoked_at IS NULL",
          [subject],
        );
      }
      await this.recordAudit({
        actor,
        action: input.disabled ? "system-user.disable" : "system-user.enable",
        target: subject,
      });
    }
    return this.principal(subject);
  }

  async deleteSystemUser(subject: string, actor: string): Promise<boolean> {
    const principal = await this.principal(subject);
    if (!principal || principal.kind !== "system") {
      return false;
    }
    await db.run("DELETE FROM principal_tokens WHERE subject = ?", [subject]);
    await db.run("DELETE FROM workspace_permission_overrides WHERE subject = ?", [subject]);
    await db.run("DELETE FROM team_members WHERE subject = ?", [subject]);
    const result = await db.run("DELETE FROM oidc_users WHERE subject = ? AND kind = 'system'", [subject]);
    if (Number(result?.changes || 0) > 0) {
      await this.recordAudit({ actor, action: "system-user.delete", target: subject });
      return true;
    }
    return false;
  }

  async listPrincipals(): Promise<Principal[]> {
    const rows = await db.all(
      "SELECT subject, name, email, photo, role, kind, disabled_at FROM oidc_users ORDER BY kind, name, email, subject",
    );
    return rows.map(normalizePrincipal);
  }

  async membership(teamId: string, subject: string): Promise<WorkspaceMembership | null> {
    const row = await db.get("SELECT role FROM team_members WHERE team_id = ? AND subject = ?", [teamId, subject]);
    if (!row) {
      return null;
    }
    const principal = await this.principal(subject);
    if (!principal || principal.disabled) {
      return null;
    }
    const overrides = await this.overrides(teamId, subject);
    const role = isWorkspaceRole(row.role) ? row.role : roleFromLegacyMemberRole(row.role);
    const capabilities = effectiveCapabilitiesFor(principal.kind, role, overrides);
    return { teamId, subject, role, overrides, capabilities: [...capabilities] };
  }

  async overrides(teamId: string, subject: string): Promise<PermissionOverride[]> {
    const rows = await db.all(
      "SELECT capability, effect FROM workspace_permission_overrides WHERE team_id = ? AND subject = ? ORDER BY capability",
      [teamId, subject],
    );
    return rows
      .filter((row: any) => isWorkspaceCapability(row.capability) && (row.effect === "allow" || row.effect === "deny"))
      .map((row: any) => ({ capability: row.capability, effect: row.effect }));
  }

  async listMembers(teamId: string): Promise<WorkspaceMemberView[]> {
    const rows = await db.all(
      `SELECT u.subject, u.name, u.email, u.role AS platform_role, u.kind, u.disabled_at, m.role
       FROM team_members m JOIN oidc_users u ON u.subject = m.subject
       WHERE m.team_id = ?
       ORDER BY m.role, u.kind, u.name, u.email`,
      [teamId],
    );
    const overrides = await db.all(
      "SELECT subject, capability, effect FROM workspace_permission_overrides WHERE team_id = ?",
      [teamId],
    );
    const bySubject = new Map<string, PermissionOverride[]>();
    for (const row of overrides) {
      if (!isWorkspaceCapability(row.capability)) {
        continue;
      }
      const list = bySubject.get(row.subject) || [];
      list.push({ capability: row.capability, effect: row.effect });
      bySubject.set(row.subject, list);
    }
    return rows.map((row: any) => {
      const kind: PrincipalKind = row.kind === "system" ? "system" : "human";
      const role = isWorkspaceRole(row.role) ? row.role : roleFromLegacyMemberRole(row.role);
      const memberOverrides = bySubject.get(row.subject) || [];
      return {
        subject: row.subject,
        name: row.name || undefined,
        email: row.email || undefined,
        kind,
        role,
        overrides: memberOverrides,
        capabilities: [...effectiveCapabilitiesFor(kind, role, memberOverrides)],
        disabled: Boolean(row.disabled_at),
      };
    });
  }

  /**
   * Replace one member's role and sparse overrides atomically; every elevation
   * is recorded.
   */
  async setMemberPermissions(
    teamId: string,
    subject: string,
    role: WorkspaceRole,
    overrides: readonly PermissionOverride[],
    actor: string,
  ): Promise<"updated" | "not-found" | "last-admin" | "system-user-retired"> {
    if (!isWorkspaceRole(role)) {
      throw new Error("Unknown workspace role");
    }
    const existing = await db.get("SELECT role FROM team_members WHERE team_id = ? AND subject = ?", [teamId, subject]);
    const principal = await this.principal(subject);
    if (!existing || !principal) {
      return "not-found";
    }
    if (principal.kind === "system") {
      return "system-user-retired";
    }
    const sanitized = sanitizeWorkspaceOverrides(overrides);
    const previousRole = isWorkspaceRole(existing.role) ? existing.role : roleFromLegacyMemberRole(existing.role);
    const statements: Array<{ s: string; d?: unknown[]; m: string }> = [
      {
        s: `UPDATE team_members SET role = ? WHERE team_id = ? AND subject = ?
            AND (role != 'admin' OR ? = 'admin' OR
              (SELECT COUNT(*) FROM team_members WHERE team_id = ? AND role = 'admin') > 1)`,
        d: [role, teamId, subject, role, teamId],
        m: "run",
      },
      {
        s: `DELETE FROM workspace_permission_overrides WHERE team_id = ? AND subject = ?
            AND EXISTS (SELECT 1 FROM team_members WHERE team_id = ? AND subject = ? AND role = ?)`,
        d: [teamId, subject, teamId, subject, role],
        m: "run",
      },
    ];
    for (const override of sanitized) {
      statements.push({
        s: `INSERT INTO workspace_permission_overrides (team_id, subject, capability, effect, granted_by)
            SELECT ?, ?, ?, ?, ? WHERE EXISTS (
              SELECT 1 FROM team_members WHERE team_id = ? AND subject = ? AND role = ?
            )`,
        d: [teamId, subject, override.capability, override.effect, actor, teamId, subject, role],
        m: "run",
      });
    }
    if (typeof db.transaction !== "function") {
      throw new Error("Atomic transactions are required to update member permissions");
    }
    await db.transaction(statements);
    const resultingMember = await db.get("SELECT role FROM team_members WHERE team_id = ? AND subject = ?", [
      teamId,
      subject,
    ]);
    if (previousRole === "admin" && role !== "admin" && resultingMember?.role === "admin") {
      return "last-admin";
    }
    const elevations = elevatedOverrides(role, sanitized);
    if (elevations.length || previousRole !== role) {
      await this.recordAudit({
        actor,
        action: "member.permissions",
        target: subject,
        teamId,
        detail: { role, previousRole, elevations },
      });
    }
    return "updated";
  }

  /** Add an existing human principal to a workspace. */
  async addMember(
    teamId: string,
    subject: string,
    role: WorkspaceRole,
    actor: string,
  ): Promise<"added" | "not-found" | "system-user-retired" | "exists"> {
    if (!isWorkspaceRole(role)) {
      throw new Error("Unknown workspace role");
    }
    const principal = await this.principal(subject);
    if (!principal) {
      return "not-found";
    }
    if (principal.kind === "system") {
      return "system-user-retired";
    }
    const existing = await db.get("SELECT 1 AS present FROM team_members WHERE team_id = ? AND subject = ?", [
      teamId,
      subject,
    ]);
    if (existing) {
      return "exists";
    }
    await db.run("INSERT INTO team_members (team_id, subject, role) VALUES (?, ?, ?)", [teamId, subject, role]);
    await this.recordAudit({ actor, action: "member.add", target: subject, teamId, detail: { role } });
    return "added";
  }

  async removeMember(teamId: string, subject: string, actor: string): Promise<"removed" | "not-found" | "admin"> {
    const result = await db.run(
      `DELETE FROM team_members
       WHERE team_id = ? AND subject = ?
       AND (role != 'admin' OR (SELECT COUNT(*) FROM team_members WHERE team_id = ? AND role = 'admin') > 1)`,
      [teamId, subject, teamId],
    );
    if (Number(result?.changes || 0) === 1) {
      await db.run("DELETE FROM workspace_permission_overrides WHERE team_id = ? AND subject = ?", [teamId, subject]);
      await this.recordAudit({ actor, action: "member.remove", target: subject, teamId });
      return "removed";
    }
    const existing = await db.get("SELECT role FROM team_members WHERE team_id = ? AND subject = ?", [teamId, subject]);
    return existing?.role === "admin" ? "admin" : "not-found";
  }

  async allWorkspaces(): Promise<Array<{ id: string; name: string; memberCount: number }>> {
    const rows = await db.all(
      `SELECT t.id, t.name, COUNT(m.subject) AS member_count
       FROM teams t LEFT JOIN team_members m ON m.team_id = t.id
       GROUP BY t.id, t.name ORDER BY t.name`,
    );
    return rows.map((row: any) => ({
      id: row.id,
      name: row.name,
      memberCount: Number(row.member_count || 0),
    }));
  }

  async workspaceRole(teamId: string, subject: string): Promise<WorkspaceRole | null> {
    const membership = await this.membership(teamId, subject);
    return membership?.role || null;
  }

  /** Workspaces visible to one principal, with the capabilities they hold there. */
  async workspaceListFor(
    subject: string,
  ): Promise<Array<{ id: string; name: string; role: WorkspaceRole; capabilities: WorkspaceCapability[] }>> {
    const rows = await this.workspacesFor(subject);
    return Promise.all(
      rows.map(async (workspace) => {
        const membership = await this.membership(workspace.id, subject);
        return { ...workspace, capabilities: membership?.capabilities || [] };
      }),
    );
  }

  async workspacesFor(subject: string): Promise<Array<{ id: string; name: string; role: WorkspaceRole }>> {
    const rows = await db.all(
      `SELECT t.id, t.name, m.role FROM teams t JOIN team_members m ON m.team_id = t.id
       WHERE m.subject = ? ORDER BY t.name`,
      [subject],
    );
    return rows.map((row: any) => ({
      id: row.id,
      name: row.name,
      role: isWorkspaceRole(row.role) ? row.role : roleFromLegacyMemberRole(row.role),
    }));
  }
}
