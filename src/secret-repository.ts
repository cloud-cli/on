import crypto from 'node:crypto';
import { readFileSync } from 'node:fs';
import db from './db-client.js';

function masterKey(): Buffer {
  const credential = process.env.CREDENTIALS_DIRECTORY ? `${process.env.CREDENTIALS_DIRECTORY}/on-master-key` : '';
  const value = process.env.RUNNER_MASTER_KEY || (credential ? readFileSync(credential, 'utf8').trim() : '');
  if (!value) throw new Error('RUNNER_MASTER_KEY or systemd credential on-master-key is required for secrets');
  return crypto.createHash('sha256').update(value).digest();
}

export class SecretRepository {
  private key?: Buffer;

  async init(): Promise<void> {
    await db.exec(`CREATE TABLE IF NOT EXISTS secrets (
      name TEXT PRIMARY KEY, ciphertext TEXT NOT NULL,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP, updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
    )`);
  }

  private encryptionKey(): Buffer {
    return this.key ||= masterKey();
  }

  async set(name: string, value: string): Promise<void> {
    if (!/^[A-Z][A-Z0-9_]*$/.test(name)) throw new Error('Secret names must be uppercase letters, numbers, and underscores');
    const nonce = crypto.randomBytes(12);
    const cipher = crypto.createCipheriv('aes-256-gcm', this.encryptionKey(), nonce);
    const encrypted = Buffer.concat([cipher.update(value, 'utf8'), cipher.final()]);
    const ciphertext = Buffer.concat([nonce, cipher.getAuthTag(), encrypted]).toString('base64');
    await db.run(`INSERT INTO secrets (name, ciphertext) VALUES (?, ?)
      ON CONFLICT(name) DO UPDATE SET ciphertext = excluded.ciphertext, updated_at = CURRENT_TIMESTAMP`, [name, ciphertext]);
  }

  async getAll(): Promise<Record<string, string>> {
    const rows = await db.all('SELECT name, ciphertext FROM secrets ORDER BY name');
    return Object.fromEntries(rows.map((row: any) => [row.name, this.decrypt(row.ciphertext)]));
  }

  async names(): Promise<string[]> {
    const rows = await db.all('SELECT name FROM secrets ORDER BY name');
    return rows.map((row: any) => row.name);
  }

  private decrypt(ciphertext: string): string {
    const value = Buffer.from(ciphertext, 'base64');
    const decipher = crypto.createDecipheriv('aes-256-gcm', this.encryptionKey(), value.subarray(0, 12));
    decipher.setAuthTag(value.subarray(12, 28));
    return Buffer.concat([decipher.update(value.subarray(28)), decipher.final()]).toString('utf8');
  }
}
