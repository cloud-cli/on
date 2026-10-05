import db from "./db-client.js";
import type { OidcUser } from "./oidc.js";

export type OidcRole = "user" | "admin";
export type OidcUserRecord = Pick<OidcUser, "id" | "name" | "email"> & { role: OidcRole };

export class OidcUserRepository {
  async init() {
    await db.exec(`CREATE TABLE IF NOT EXISTS oidc_users (
      subject TEXT PRIMARY KEY, email TEXT, name TEXT, photo TEXT,
      role TEXT NOT NULL DEFAULT 'user',
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
    )`);
  }

  async upsert(user: OidcUser) {
    await db.run(
      `INSERT INTO oidc_users (subject, email, name, photo) VALUES (?, ?, ?, ?)
      ON CONFLICT(subject) DO UPDATE SET email = excluded.email, name = excluded.name, photo = excluded.photo, updated_at = CURRENT_TIMESTAMP`,
      [user.id, user.email || null, user.name || null, user.photo || null],
    );
  }

  async role(subject: string): Promise<OidcRole> {
    const row = await db.get("SELECT role FROM oidc_users WHERE subject = ?", [subject]);
    return row?.role === "admin" ? "admin" : "user";
  }

  async list(): Promise<OidcUserRecord[]> {
    const rows = await db.all("SELECT subject, name, email, role FROM oidc_users ORDER BY name, email, subject");
    return rows.map((row: any) => ({
      id: row.subject,
      name: row.name || undefined,
      email: row.email || undefined,
      role: row.role === "admin" ? "admin" : "user",
    }));
  }

  async setRole(subject: string, role: OidcRole): Promise<"updated" | "not-found" | "last-admin"> {
    const current = await db.get("SELECT role FROM oidc_users WHERE subject = ?", [subject]);
    if (!current) return "not-found";
    if (current.role === role) return "updated";

    // Keep the last-admin check inside the UPDATE predicate so concurrent role
    // changes cannot demote the final administrator.
    const result = await db.run(
      `UPDATE oidc_users SET role = ?, updated_at = CURRENT_TIMESTAMP
       WHERE subject = ? AND (? = 'admin' OR role != 'admin' OR
         (SELECT COUNT(*) FROM oidc_users WHERE role = 'admin') > 1)`,
      [role, subject, role],
    );
    if (Number(result?.changes || 0) > 0) return "updated";

    const stillExists = await db.get("SELECT subject FROM oidc_users WHERE subject = ?", [subject]);
    return stillExists ? "last-admin" : "not-found";
  }

  async promote(subject: string) {
    const result = await db.run(
      "UPDATE oidc_users SET role = 'admin', updated_at = CURRENT_TIMESTAMP WHERE subject = ?",
      [subject],
    );
    return Number(result?.changes || 0) > 0;
  }
}
