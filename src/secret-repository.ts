import crypto from "node:crypto";
import { readFileSync } from "node:fs";
import db from "./db-client.js";
import { ensureTeamDataSchema } from "./team-data-schema.js";

export type SecretEncoding = "utf8" | "base64";
export type StoredSecret = { value: string; encoding: SecretEncoding };

function masterKey(): Buffer {
  const credential = process.env.CREDENTIALS_DIRECTORY ? `${process.env.CREDENTIALS_DIRECTORY}/on-master-key` : "";
  const value = process.env.RUNNER_MASTER_KEY || (credential ? readFileSync(credential, "utf8").trim() : "");
  if (!value) throw new Error("RUNNER_MASTER_KEY or systemd credential on-master-key is required for secrets");
  return crypto.createHash("sha256").update(value).digest();
}

export class SecretRepository {
  private key?: Buffer;

  async init(): Promise<void> {
    await ensureTeamDataSchema();
    await db.exec(`CREATE TABLE IF NOT EXISTS secrets (
      name TEXT PRIMARY KEY, ciphertext TEXT NOT NULL,
      encoding TEXT NOT NULL DEFAULT 'utf8',
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP, updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
    )`);
    await db.run("ALTER TABLE secrets ADD COLUMN encoding TEXT NOT NULL DEFAULT 'utf8'").catch(() => {});
    await db.run(`INSERT OR IGNORE INTO team_secrets (team_id, name, ciphertext, encoding, created_at, updated_at)
      SELECT 'default', name, ciphertext, encoding, created_at, updated_at FROM secrets`);
  }

  private encryptionKey(): Buffer {
    return (this.key ||= masterKey());
  }

  async set(name: string, value: string, encoding: SecretEncoding = "utf8"): Promise<void> {
    return this.setForTeam("default", name, value, encoding);
  }

  async setForTeam(teamId: string, name: string, value: string, encoding: SecretEncoding = "utf8"): Promise<void> {
    if (!/^[A-Z][A-Z0-9_]*$/.test(name))
      throw new Error("Secret names must be uppercase letters, numbers, and underscores");
    if (encoding !== "utf8" && encoding !== "base64") throw new Error("Secret encoding must be utf8 or base64");
    const nonce = crypto.randomBytes(12);
    const cipher = crypto.createCipheriv("aes-256-gcm", this.encryptionKey(), nonce);
    const bytes = encoding === "base64" ? Buffer.from(value, "base64") : Buffer.from(value, "utf8");
    const encrypted = Buffer.concat([cipher.update(bytes), cipher.final()]);
    const ciphertext = Buffer.concat([nonce, cipher.getAuthTag(), encrypted]).toString("base64");
    await db.run(
      `INSERT INTO team_secrets (team_id, name, ciphertext, encoding) VALUES (?, ?, ?, ?)
      ON CONFLICT(team_id, name) DO UPDATE SET ciphertext = excluded.ciphertext, encoding = excluded.encoding, updated_at = CURRENT_TIMESTAMP`,
      [teamId, name, ciphertext, encoding],
    );
  }

  async getAll(): Promise<Record<string, string>> {
    return this.getAllForTeam("default");
  }

  async getAllForTeam(teamId: string): Promise<Record<string, string>> {
    const rows = await db.all("SELECT name, ciphertext, encoding FROM team_secrets WHERE team_id = ? ORDER BY name", [
      teamId,
    ]);
    return Object.fromEntries(rows.map((row: any) => [row.name, this.decrypt(row.ciphertext, row.encoding)]));
  }

  async getAllForJob(teamId = "default"): Promise<Record<string, StoredSecret>> {
    const rows = await db.all("SELECT name, ciphertext, encoding FROM team_secrets WHERE team_id = ? ORDER BY name", [
      teamId,
    ]);
    return Object.fromEntries(
      rows.map((row: any) => [
        row.name,
        { value: this.decrypt(row.ciphertext, row.encoding), encoding: row.encoding || "utf8" },
      ]),
    );
  }

  async names(): Promise<string[]> {
    return this.namesForTeam("default");
  }

  async namesForTeam(teamId: string): Promise<string[]> {
    const rows = await db.all("SELECT name FROM team_secrets WHERE team_id = ? ORDER BY name", [teamId]);
    return rows.map((row: any) => row.name);
  }

  async delete(name: string): Promise<boolean> {
    return this.deleteForTeam("default", name);
  }

  async deleteForTeam(teamId: string, name: string): Promise<boolean> {
    const result = await db.run("DELETE FROM team_secrets WHERE team_id = ? AND name = ?", [teamId, name]);
    return Number(result?.changes || 0) > 0;
  }

  private decrypt(ciphertext: string, encoding: SecretEncoding = "utf8"): string {
    const value = Buffer.from(ciphertext, "base64");
    const decipher = crypto.createDecipheriv("aes-256-gcm", this.encryptionKey(), value.subarray(0, 12));
    decipher.setAuthTag(value.subarray(12, 28));
    const plaintext = Buffer.concat([decipher.update(value.subarray(28)), decipher.final()]);
    return encoding === "base64" ? plaintext.toString("base64") : plaintext.toString("utf8");
  }
}
