import crypto from "node:crypto";
import db from "./db-client.js";

const opaque = (bytes = 32) => crypto.randomBytes(bytes).toString("base64url");
const digest = (value: string) => crypto.createHash("sha256").update(value).digest("hex");

export type TeamRole = "viewer" | "collaborator" | "admin";

/** Persistence primitives for team membership and one-use, email-bound invitations. */
export class TeamRepository {
  async listAll() {
    return db.all("SELECT id, name FROM teams ORDER BY name");
  }

  async listForUser(subject: string) {
    return db.all(
      `SELECT t.id, t.name, m.role FROM teams t JOIN team_members m ON m.team_id = t.id
       WHERE m.subject = ? ORDER BY t.name`,
      [subject],
    );
  }

  async listMembers(teamId: string) {
    return db.all(
      `SELECT u.subject, u.email, u.name, m.role, m.created_at
       FROM team_members m JOIN oidc_users u ON u.subject = m.subject
       WHERE m.team_id = ? ORDER BY m.role, u.name, u.email`,
      [teamId],
    );
  }

  async setMemberRole(
    teamId: string,
    subject: string,
    role: TeamRole,
  ): Promise<"updated" | "not-found" | "last-admin"> {
    const result = await db.run(
      `UPDATE team_members SET role = ?
       WHERE team_id = ? AND subject = ?
       AND (role != 'admin' OR ? = 'admin' OR
         (SELECT COUNT(*) FROM team_members WHERE team_id = ? AND role = 'admin') > 1)`,
      [role, teamId, subject, role, teamId],
    );
    if (Number(result?.changes || 0) === 1) {
      return "updated";
    }
    const existing = await db.get("SELECT role FROM team_members WHERE team_id = ? AND subject = ?", [teamId, subject]);
    return existing?.role === "admin" && role !== "admin" ? "last-admin" : "not-found";
  }

  async createInvitation(teamId: string, email: string, creator: string, ttlMs = 7 * 24 * 60 * 60 * 1000) {
    if (!Number.isSafeInteger(ttlMs) || ttlMs < 60_000 || ttlMs > 30 * 24 * 60 * 60 * 1000) {
      throw new Error("Invitation expiry must be between one minute and 30 days");
    }
    const normalizedEmail = email.trim().toLowerCase();
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(normalizedEmail)) {
      throw new Error("A valid email is required");
    }
    const token = opaque();
    const id = opaque(18);
    const expiresAt = new Date(Date.now() + ttlMs).toISOString();
    await db.run(
      `INSERT INTO team_invitations (id, team_id, email, token_hash, expires_at, created_by)
       VALUES (?, ?, ?, ?, ?, ?)`,
      [id, teamId, normalizedEmail, digest(token), expiresAt, creator],
    );
    return { id, token, expiresAt };
  }

  async acceptInvitation(token: string, subject: string, email: string): Promise<"accepted" | "invalid"> {
    if (!token || !subject || !email) {
      return "invalid";
    }
    const normalizedEmail = email.trim().toLowerCase();
    // Resolve the target workspace before the mutation. A unique claim marker lets
    // the transactional insert prove that this request, not a concurrent caller,
    // consumed the invitation.
    const invitation = await db.get(
      `SELECT id, team_id FROM team_invitations
       WHERE token_hash = ? AND email = ? AND accepted_at IS NULL AND julianday(expires_at) > julianday('now')`,
      [digest(token), normalizedEmail],
    );
    if (!invitation) {
      return "invalid";
    }
    if (typeof db.transaction !== "function") {
      throw new Error("Atomic transactions are required to accept workspace invitations");
    }
    const claim = `${new Date().toISOString()}:${opaque(12)}`;
    await db.transaction([
      {
        s: `UPDATE team_invitations SET accepted_at = ?
            WHERE id = ? AND token_hash = ? AND email = ? AND accepted_at IS NULL
              AND julianday(expires_at) > julianday('now')`,
        d: [claim, invitation.id, digest(token), normalizedEmail],
        m: "run",
      },
      {
        s: `INSERT INTO team_members (team_id, subject, role)
            SELECT ?, ?, 'collaborator' FROM team_invitations
            WHERE id = ? AND accepted_at = ?
            ON CONFLICT(team_id, subject) DO NOTHING`,
        d: [invitation.team_id, subject, invitation.id, claim],
        m: "run",
      },
    ]);
    return (await db.get("SELECT 1 AS present FROM team_invitations WHERE id = ? AND accepted_at = ?", [
      invitation.id,
      claim,
    ]))
      ? "accepted"
      : "invalid";
  }

  async isMember(teamId: string, subject: string): Promise<boolean> {
    return Boolean(await db.get("SELECT 1 FROM team_members WHERE team_id = ? AND subject = ?", [teamId, subject]));
  }

  async isAdmin(teamId: string, subject: string): Promise<boolean> {
    return Boolean(
      await db.get("SELECT 1 FROM team_members WHERE team_id = ? AND subject = ? AND role = 'admin'", [
        teamId,
        subject,
      ]),
    );
  }

  async createTeam(name: string, creator: string) {
    const trimmedName = name.trim();
    if (!trimmedName || trimmedName.length > 100) {
      throw new Error("Team name must be between 1 and 100 characters");
    }
    const id = opaque(18);
    const token = opaque();
    if (typeof db.transaction !== "function") {
      throw new Error("Atomic transactions are required to create a workspace");
    }
    await db.transaction([
      {
        s: "INSERT INTO teams (id, name, webhook_token) VALUES (?, ?, ?)",
        d: [id, trimmedName, digest(token)],
        m: "run",
      },
      { s: "INSERT INTO team_members (team_id, subject, role) VALUES (?, ?, 'admin')", d: [id, creator], m: "run" },
    ]);
    return { id, name: trimmedName, webhookToken: token };
  }

  async renameTeam(teamId: string, name: string) {
    const trimmedName = name.trim();
    if (!trimmedName || trimmedName.length > 100) {
      throw new Error("Team name must be between 1 and 100 characters");
    }
    const result = await db.run("UPDATE teams SET name = ? WHERE id = ?", [trimmedName, teamId]);
    if (Number(result?.changes || 0) !== 1) {
      throw new Error("Team not found");
    }
    return { id: teamId, name: trimmedName };
  }

  async rotateWebhookToken(teamId: string) {
    const token = opaque();
    const result = await db.run("UPDATE teams SET webhook_token = ? WHERE id = ?", [digest(token), teamId]);
    return Number(result?.changes || 0) ? token : null;
  }

  async teamForWebhookToken(token: string) {
    if (!token || token.length > 200) {
      return null;
    }
    // Earlier deployments stored the default team's random token directly; support it until rotated.
    return db.get("SELECT id FROM teams WHERE webhook_token = ? OR webhook_token = ? LIMIT 1", [digest(token), token]);
  }

  /**
   * Permanently remove a workspace and every workspace-owned record. Job rows
   * and external artifacts are purged separately by the caller so that file
   * storage cleanup cannot be skipped by a foreign-key cascade.
   */
  async deleteWorkspace(teamId: string): Promise<boolean> {
    const existing = await db.get("SELECT id FROM teams WHERE id = ?", [teamId]);
    if (!existing) {
      return false;
    }
    if (typeof db.transaction !== "function") {
      throw new Error("Atomic transactions are required to delete a workspace");
    }
    const statements = [
      { s: "DELETE FROM step_logs WHERE job_id IN (SELECT id FROM jobs WHERE team_id = ?)", d: [teamId], m: "run" },
      {
        s: `DELETE FROM stored_files
            WHERE (kind = 'artifact' AND owner_key IN (SELECT CAST(id AS TEXT) FROM jobs WHERE team_id = ?))
              OR (kind = 'cache' AND EXISTS (
                SELECT 1 FROM workflows WHERE workflows.team_id = ?
                  AND substr(stored_files.owner_key, 1, length(workflows.id) + 1) = workflows.id || ':'
              ))`,
        d: [teamId, teamId],
        m: "run",
      },
      { s: "DELETE FROM ai_requests WHERE job_id IN (SELECT id FROM jobs WHERE team_id = ?)", d: [teamId], m: "run" },
      {
        s: "UPDATE jobs SET parentId = NULL WHERE parentId IN (SELECT id FROM jobs WHERE team_id = ?)",
        d: [teamId],
        m: "run",
      },
      { s: "DELETE FROM jobs WHERE team_id = ?", d: [teamId], m: "run" },
      {
        s: "DELETE FROM scheduled_runs WHERE workflow_id IN (SELECT id FROM workflows WHERE team_id = ?)",
        d: [teamId],
        m: "run",
      },
      {
        s: "DELETE FROM workflow_revisions WHERE workflow_id IN (SELECT id FROM workflows WHERE team_id = ?)",
        d: [teamId],
        m: "run",
      },
      { s: "DELETE FROM workflows WHERE team_id = ?", d: [teamId], m: "run" },
      { s: "DELETE FROM team_secrets WHERE team_id = ?", d: [teamId], m: "run" },
      { s: "DELETE FROM workspace_webhooks WHERE team_id = ?", d: [teamId], m: "run" },
      { s: "DELETE FROM team_invitations WHERE team_id = ?", d: [teamId], m: "run" },
      { s: "DELETE FROM workspace_permission_overrides WHERE team_id = ?", d: [teamId], m: "run" },
      { s: "DELETE FROM runner_team_grants WHERE team_id = ?", d: [teamId], m: "run" },
      {
        s: "DELETE FROM runner_updates WHERE runner_id IN (SELECT id FROM runners WHERE team_id = ?)",
        d: [teamId],
        m: "run",
      },
      { s: "DELETE FROM runner_enrollments WHERE team_id = ?", d: [teamId], m: "run" },
      { s: "DELETE FROM runners WHERE team_id = ?", d: [teamId], m: "run" },
      { s: "DELETE FROM team_members WHERE team_id = ?", d: [teamId], m: "run" },
      { s: "DELETE FROM teams WHERE id = ?", d: [teamId], m: "run" },
    ];
    await db.transaction(statements);
    return true;
  }

  async webhookUrl(teamId: string) {
    return db.get("SELECT webhook_token FROM teams WHERE id = ?", [teamId]);
  }

  async markWorkspaceDeleting(teamId: string): Promise<boolean> {
    const result = await db.run(
      "UPDATE teams SET deleting_at = COALESCE(deleting_at, CURRENT_TIMESTAMP) WHERE id = ?",
      [teamId],
    );
    return Number(result?.changes || 0) === 1;
  }
}
