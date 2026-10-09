import crypto from "node:crypto";
import db from "./db-client.js";

const opaque = (bytes = 32) => crypto.randomBytes(bytes).toString("base64url");
const digest = (value: string) => crypto.createHash("sha256").update(value).digest("hex");

export type TeamRole = "admin" | "member";

/** Persistence primitives for team membership and one-use, email-bound invitations. */
export class TeamRepository {
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

  async removeMember(teamId: string, subject: string): Promise<"removed" | "not-found" | "admin"> {
    const member = await db.get("SELECT role FROM team_members WHERE team_id = ? AND subject = ?", [teamId, subject]);
    if (!member) return "not-found";
    if (member.role === "admin") return "admin";
    const result = await db.run("DELETE FROM team_members WHERE team_id = ? AND subject = ? AND role = 'member'", [
      teamId,
      subject,
    ]);
    return Number(result?.changes || 0) === 1 ? "removed" : "not-found";
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
    if (Number(result?.changes || 0) === 1) return "updated";
    const existing = await db.get("SELECT role FROM team_members WHERE team_id = ? AND subject = ?", [teamId, subject]);
    return existing?.role === "admin" && role === "member" ? "last-admin" : "not-found";
  }

  async createInvitation(teamId: string, email: string, creator: string, ttlMs = 7 * 24 * 60 * 60 * 1000) {
    if (!Number.isSafeInteger(ttlMs) || ttlMs < 60_000 || ttlMs > 30 * 24 * 60 * 60 * 1000) {
      throw new Error("Invitation expiry must be between one minute and 30 days");
    }
    const normalizedEmail = email.trim().toLowerCase();
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(normalizedEmail)) throw new Error("A valid email is required");
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
    if (!token || !subject || !email) return "invalid";
    const normalizedEmail = email.trim().toLowerCase();
    // Claim atomically in one conditional statement: concurrent requests can consume this invite once.
    const invitation = await db.get(
      `UPDATE team_invitations SET accepted_at = CURRENT_TIMESTAMP
       WHERE token_hash = ? AND email = ? AND accepted_at IS NULL AND julianday(expires_at) > julianday('now')
       RETURNING team_id`,
      [digest(token), normalizedEmail],
    );
    if (!invitation) return "invalid";
    await db.run(
      `INSERT INTO team_members (team_id, subject, role) VALUES (?, ?, 'member')
       ON CONFLICT(team_id, subject) DO NOTHING`,
      [invitation.team_id, subject],
    );
    return "accepted";
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
    if (!trimmedName || trimmedName.length > 100) throw new Error("Team name must be between 1 and 100 characters");
    const id = opaque(18);
    const token = opaque();
    await db.run("INSERT INTO teams (id, name, webhook_token) VALUES (?, ?, ?)", [id, trimmedName, digest(token)]);
    await db.run("INSERT INTO team_members (team_id, subject, role) VALUES (?, ?, 'admin')", [id, creator]);
    return { id, name: trimmedName, webhookToken: token };
  }

  async rotateWebhookToken(teamId: string) {
    const token = opaque();
    const result = await db.run("UPDATE teams SET webhook_token = ? WHERE id = ?", [digest(token), teamId]);
    return Number(result?.changes || 0) ? token : null;
  }

  async teamForWebhookToken(token: string) {
    if (!token || token.length > 200) return null;
    // Earlier deployments stored the default team's random token directly; support it until rotated.
    return db.get("SELECT id FROM teams WHERE webhook_token = ? OR webhook_token = ? LIMIT 1", [digest(token), token]);
  }

  async webhookUrl(teamId: string) {
    return db.get("SELECT webhook_token FROM teams WHERE id = ?", [teamId]);
  }
}
