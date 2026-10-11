import crypto from "node:crypto";
import db from "./db-client.js";
import { SecretRepository } from "./secret-repository.js";

export type WorkspaceWebhook = {
  id: string;
  workspaceId: string;
  provider: string;
  createdAt: string;
};

export type ResolvedWorkspaceWebhook = {
  workspaceId: string;
  provider: string;
  signingSecret: string;
};

const digest = (token: string) => crypto.createHash("sha256").update(token).digest("hex");
/** Persisted, independently signed webhook registrations scoped to a workspace/team. */
export class WorkspaceWebhookRepository {
  constructor(private readonly secrets = new SecretRepository()) {}

  async init(): Promise<void> {
    await db.exec(`
      CREATE TABLE IF NOT EXISTS workspace_webhooks (
        id TEXT PRIMARY KEY,
        team_id TEXT NOT NULL REFERENCES teams(id) ON DELETE CASCADE,
        provider TEXT NOT NULL CHECK (provider GLOB '[a-z0-9-]*' AND provider NOT GLOB '*[^a-z0-9-]*'),
        token_hash TEXT NOT NULL UNIQUE,
        signing_secret TEXT NOT NULL,
        created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
      );
      CREATE INDEX IF NOT EXISTS idx_workspace_webhooks_team ON workspace_webhooks(team_id, created_at);
    `);
  }

  async create(workspaceId: string, provider: string): Promise<WorkspaceWebhook & { token: string; signingSecret: string }> {
    if (!/^[a-z0-9-]+$/.test(provider)) {throw new Error("Provider must be a lowercase slug");}
    const id = crypto.randomUUID();
    const token = crypto.randomBytes(32).toString("base64url");
    const signingSecret = crypto.randomBytes(32).toString("base64url");
    const encryptedSecret = this.secrets.encryptValue(signingSecret);
    await db.run(
      "INSERT INTO workspace_webhooks (id, team_id, provider, token_hash, signing_secret) VALUES (?, ?, ?, ?, ?)",
      [id, workspaceId, provider, digest(token), encryptedSecret],
    );
    const row = await db.get("SELECT created_at FROM workspace_webhooks WHERE id = ?", [id]);
    return { id, workspaceId, provider, createdAt: row?.created_at, token, signingSecret };
  }

  async list(workspaceId: string): Promise<WorkspaceWebhook[]> {
    const rows = await db.all(
      "SELECT id, team_id AS workspaceId, provider, created_at AS createdAt FROM workspace_webhooks WHERE team_id = ? ORDER BY created_at, id",
      [workspaceId],
    );
    return rows;
  }

  async revoke(workspaceId: string, id: string): Promise<boolean> {
    const deleted = await db.run("DELETE FROM workspace_webhooks WHERE team_id = ? AND id = ?", [workspaceId, id]);
    return Number(deleted?.changes || 0) > 0;
  }

  async lookupByToken(token: string): Promise<ResolvedWorkspaceWebhook | null> {
    const row = await db.get(
      "SELECT team_id, provider, signing_secret FROM workspace_webhooks WHERE token_hash = ?",
      [digest(token)],
    );
    if (!row) {return null;}
    const signingSecret = this.secrets.decryptValue(row.signing_secret);
    return { workspaceId: row.team_id, provider: row.provider, signingSecret };
  }
}
