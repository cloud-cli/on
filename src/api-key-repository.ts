import crypto from 'node:crypto';
import db from './db-client.js';

export const API_KEY_SCOPES = ['workflows:read', 'workflows:write', 'logs:read', 'artifacts:read', 'runs:control', 'runs:dispatch', 'workers:read'] as const;
export type ApiKeyScope = (typeof API_KEY_SCOPES)[number];

export class ApiKeyRepository {
  async init(): Promise<void> {
    await db.exec(`CREATE TABLE IF NOT EXISTS api_keys (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      key_hash TEXT NOT NULL UNIQUE,
      scopes TEXT NOT NULL,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      last_used_at DATETIME,
      revoked_at DATETIME
    )`);
  }

  async list() {
    const rows = await db.all('SELECT id, name, scopes, created_at, last_used_at FROM api_keys WHERE revoked_at IS NULL ORDER BY created_at DESC');
    return rows.map((row: any) => ({ ...row, scopes: JSON.parse(row.scopes) }));
  }

  async issue(name: string, scopes: string[]) {
    const validScopes = [...new Set(scopes.filter((scope): scope is ApiKeyScope => (API_KEY_SCOPES as readonly string[]).includes(scope)))];
    if (!name.trim() || !validScopes.length) throw new Error('A name and at least one valid scope are required');
    const id = crypto.randomUUID();
    const token = `on_${crypto.randomBytes(32).toString('base64url')}`;
    const keyHash = crypto.createHash('sha256').update(token).digest('hex');
    await db.run('INSERT INTO api_keys (id, name, key_hash, scopes) VALUES (?, ?, ?, ?)', [id, name.trim(), keyHash, JSON.stringify(validScopes)]);
    return { id, name: name.trim(), scopes: validScopes, token };
  }

  async scopesForToken(token: string): Promise<string[] | null> {
    const keyHash = crypto.createHash('sha256').update(token).digest('hex');
    const row = await db.get('SELECT id, scopes FROM api_keys WHERE key_hash = ? AND revoked_at IS NULL', [keyHash]);
    if (!row) return null;
    await db.run('UPDATE api_keys SET last_used_at = CURRENT_TIMESTAMP WHERE id = ?', [row.id]);
    return JSON.parse(row.scopes);
  }

  async revoke(id: string): Promise<boolean> {
    const result = await db.run('UPDATE api_keys SET revoked_at = CURRENT_TIMESTAMP WHERE id = ? AND revoked_at IS NULL', [id]);
    return Number(result?.changes || 0) > 0;
  }
}
