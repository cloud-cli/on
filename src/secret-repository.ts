import crypto from "node:crypto";
import { readFileSync } from "node:fs";
import db from "./db-client.js";
import { ensureTeamDataSchema } from "./team-data-schema.js";

export type SecretEncoding = "utf8" | "base64";
export type StoredSecret = { value: string; encoding: SecretEncoding };

function masterKey(): Buffer {
  const credential = process.env.CREDENTIALS_DIRECTORY ? `${process.env.CREDENTIALS_DIRECTORY}/on-master-key` : "";
  const value = process.env.RUNNER_MASTER_KEY || (credential ? readFileSync(credential, "utf8").trim() : "");
  if (!value) {
    throw new Error("RUNNER_MASTER_KEY or systemd credential on-master-key is required for secrets");
  }
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
    const legacy = await db.get("SELECT 1 AS present FROM secrets LIMIT 1");
    if (legacy) {
      throw new Error("Legacy secrets require explicit workspace assignment");
    }
  }

  private encryptionKey(): Buffer {
    return (this.key ||= masterKey());
  }

  async set(name: string, value: string, encoding: SecretEncoding = "utf8"): Promise<void> {
    throw new Error("An explicit workspace is required to store secrets");
  }

  async setForTeam(teamId: string, name: string, value: string, encoding: SecretEncoding = "utf8"): Promise<void> {
    if (!/^[A-Z][A-Z0-9_]*$/.test(name)) {
      throw new Error("Secret names must be uppercase letters, numbers, and underscores");
    }
    if (encoding !== "utf8" && encoding !== "base64") {
      throw new Error("Secret encoding must be utf8 or base64");
    }
    const nonce = crypto.randomBytes(12);
    const cipher = crypto.createCipheriv("aes-256-gcm", this.encryptionKey(), nonce);
    const bytes = encoding === "base64" ? Buffer.from(value, "base64") : Buffer.from(value, "utf8");
    const encrypted = Buffer.concat([cipher.update(bytes), cipher.final()]);
    const ciphertext = Buffer.concat([nonce, cipher.getAuthTag(), encrypted]).toString("base64");
    const old = await db.get("SELECT ciphertext, encoding FROM team_secrets WHERE team_id = ? AND name = ?", [
      teamId,
      name,
    ]);
    const redact = old ? this.redactionValues(old.ciphertext, old.encoding) : [];
    const statements = [
      ...this.scrubStatements(teamId, redact),
      {
        s: `INSERT INTO team_secrets (team_id, name, ciphertext, encoding) VALUES (?, ?, ?, ?)
            ON CONFLICT(team_id, name) DO UPDATE SET ciphertext = excluded.ciphertext,
              encoding = excluded.encoding, updated_at = CURRENT_TIMESTAMP`,
        d: [teamId, name, ciphertext, encoding],
        m: "run",
      },
    ];
    await this.runSecretMutation(statements);
  }

  private redactionValues(ciphertext: string, encoding: SecretEncoding): string[] {
    const bytes = Buffer.from(this.decrypt(ciphertext, encoding), encoding === "base64" ? "base64" : "utf8");
    const values = [bytes.toString("utf8"), bytes.toString("base64")].filter((value) => value.length > 0);
    return [...new Set(values.flatMap((value) => [value, JSON.stringify(value).slice(1, -1)]))];
  }

  private scrubStatements(teamId: string, values: string[]) {
    return values.flatMap((secret) => [
      {
        s: `UPDATE step_logs SET log_content = replace(log_content, ?, '[REDACTED]')
            WHERE job_id IN (SELECT id FROM jobs WHERE team_id = ?) AND instr(log_content, ?) > 0`,
        d: [secret, teamId, secret],
        m: "run",
      },
      {
        s: `UPDATE jobs SET report = replace(report, ?, '[REDACTED]')
            WHERE team_id = ? AND report IS NOT NULL AND instr(report, ?) > 0`,
        d: [secret, teamId, secret],
        m: "run",
      },
    ]);
  }

  private async runSecretMutation(statements: Array<{ s: string; d?: unknown[]; m: string }>): Promise<void> {
    if (typeof db.transaction !== "function") {
      throw new Error("Atomic transactions are required to rotate or delete workspace secrets");
    }
    await db.transaction(statements);
  }

  async getAll(): Promise<Record<string, string>> {
    throw new Error("An explicit workspace is required to list secrets");
  }

  async getAllForTeam(teamId: string): Promise<Record<string, string>> {
    const rows = await db.all("SELECT name, ciphertext, encoding FROM team_secrets WHERE team_id = ? ORDER BY name", [
      teamId,
    ]);
    return Object.fromEntries(rows.map((row: any) => [row.name, this.decrypt(row.ciphertext, row.encoding)]));
  }

  async getForTeam(teamId: string, name: string): Promise<string | undefined> {
    const row = await db.get("SELECT ciphertext, encoding FROM team_secrets WHERE team_id = ? AND name = ?", [
      teamId,
      name,
    ]);
    return row ? this.decrypt(row.ciphertext, row.encoding) : undefined;
  }

  /** Encrypts an isolated secret without adding it to workflow-visible team secrets. */
  encryptValue(value: string): string {
    const nonce = crypto.randomBytes(12);
    const cipher = crypto.createCipheriv("aes-256-gcm", this.encryptionKey(), nonce);
    const encrypted = Buffer.concat([cipher.update(Buffer.from(value, "utf8")), cipher.final()]);
    return Buffer.concat([nonce, cipher.getAuthTag(), encrypted]).toString("base64");
  }

  /** Decrypts an isolated UTF-8 secret stored outside the workflow secret namespace. */
  decryptValue(ciphertext: string): string {
    return this.decrypt(ciphertext, "utf8");
  }

  async getAllForJob(teamId: string): Promise<Record<string, StoredSecret>> {
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
    throw new Error("An explicit workspace is required to list secrets");
  }

  async namesForTeam(teamId: string): Promise<string[]> {
    const rows = await db.all("SELECT name FROM team_secrets WHERE team_id = ? ORDER BY name", [teamId]);
    return rows.map((row: any) => row.name);
  }

  async delete(name: string): Promise<boolean> {
    throw new Error("An explicit workspace is required to delete secrets");
  }

  async deleteForTeam(teamId: string, name: string): Promise<boolean> {
    const old = await db.get("SELECT ciphertext, encoding FROM team_secrets WHERE team_id = ? AND name = ?", [
      teamId,
      name,
    ]);
    if (!old) {
      return false;
    }
    const statements = [
      ...this.scrubStatements(teamId, this.redactionValues(old.ciphertext, old.encoding)),
      { s: "DELETE FROM team_secrets WHERE team_id = ? AND name = ?", d: [teamId, name], m: "run" },
    ];
    await this.runSecretMutation(statements);
    return true;
  }

  private decrypt(ciphertext: string, encoding: SecretEncoding = "utf8"): string {
    const value = Buffer.from(ciphertext, "base64");
    const decipher = crypto.createDecipheriv("aes-256-gcm", this.encryptionKey(), value.subarray(0, 12));
    decipher.setAuthTag(value.subarray(12, 28));
    const plaintext = Buffer.concat([decipher.update(value.subarray(28)), decipher.final()]);
    return encoding === "base64" ? plaintext.toString("base64") : plaintext.toString("utf8");
  }
}
