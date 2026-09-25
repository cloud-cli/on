import db from './db-client.js';
import type { OidcUser } from './oidc.js';

export type OidcRole = 'user' | 'admin';

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
    await db.run(`INSERT INTO oidc_users (subject, email, name, photo) VALUES (?, ?, ?, ?)
      ON CONFLICT(subject) DO UPDATE SET email = excluded.email, name = excluded.name, photo = excluded.photo, updated_at = CURRENT_TIMESTAMP`,
    [user.id, user.email || null, user.name || null, user.photo || null]);
  }

  async role(subject: string): Promise<OidcRole> {
    const row = await db.get('SELECT role FROM oidc_users WHERE subject = ?', [subject]);
    return row?.role === 'admin' ? 'admin' : 'user';
  }

  async promote(subject: string) {
    const result = await db.run("UPDATE oidc_users SET role = 'admin', updated_at = CURRENT_TIMESTAMP WHERE subject = ?", [subject]);
    return Number(result?.changes || 0) > 0;
  }
}
