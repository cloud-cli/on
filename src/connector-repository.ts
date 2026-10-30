import crypto from "node:crypto";
import db from "./db-client.js";

export type Connector = {
  id: string;
  workspaceId: string;
  name: string;
  sourceYaml: string;
  version: number;
  enabled: boolean;
  createdAt: string;
  updatedAt: string;
};

export type CreatedConnector = Connector & { token: string };

export type ResolvedConnector = {
  id: string;
  workspaceId: string;
  name: string;
  sourceYaml: string;
  version: number;
};

const MAX_ID_LENGTH = 64;
const MAX_NAME_LENGTH = 200;
const MAX_SOURCE_LENGTH = 256_000;
const tokenDigest = (token: string) => crypto.createHash("sha256").update(token).digest("hex");

function validate(id: string, name: string, sourceYaml: string): void {
  if (typeof id !== "string" || id.length > MAX_ID_LENGTH || !/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(id)) {
    throw new Error("Connector id must be a lowercase slug of at most 64 characters");
  }
  if (typeof name !== "string" || name.trim().length === 0 || name.length > MAX_NAME_LENGTH) {
    throw new Error("Connector name must contain 1 to 200 characters");
  }
  if (typeof sourceYaml !== "string" || sourceYaml.length === 0 || sourceYaml.length > MAX_SOURCE_LENGTH) {
    throw new Error("Connector YAML source must contain 1 to 256000 characters");
  }
}

/** Workspace-scoped YAML connector persistence. Webhook tokens are returned only once at creation. */
export class ConnectorRepository {
  async createForWorkspace(
    workspaceId: string,
    id: string,
    name: string,
    sourceYaml: string,
  ): Promise<CreatedConnector> {
    validate(id, name, sourceYaml);
    const token = crypto.randomBytes(32).toString("base64url");
    const digest = tokenDigest(token);
    await db.run(
      `INSERT INTO connectors (team_id, connector_id, name, source_yaml, revision, webhook_token_hash, enabled)
       VALUES (?, ?, ?, ?, 1, ?, 1)`,
      [workspaceId, id, name, sourceYaml, digest],
    );
    const connector = await this.getForWorkspace(workspaceId, id);
    if (!connector) {
      throw new Error("Connector could not be stored");
    }
    return { ...connector, token };
  }

  async updateForWorkspace(
    workspaceId: string,
    id: string,
    name: string,
    sourceYaml: string,
  ): Promise<Connector | null> {
    validate(id, name, sourceYaml);
    const updated = await db.run(
      `UPDATE connectors SET name = ?, source_yaml = ?, revision = revision + 1, updated_at = CURRENT_TIMESTAMP
       WHERE team_id = ? AND connector_id = ? AND enabled = 1`,
      [name, sourceYaml, workspaceId, id],
    );
    if (Number(updated?.changes || 0) === 0) {
      return null;
    }
    return this.getForWorkspace(workspaceId, id);
  }

  async listForWorkspace(workspaceId: string): Promise<Connector[]> {
    const rows = await db.all(
      `SELECT connector_id, team_id, name, source_yaml, revision, enabled, created_at, updated_at
       FROM connectors WHERE team_id = ? ORDER BY connector_id`,
      [workspaceId],
    );
    return rows.map((row: any) => this.parse(row));
  }

  async getForWorkspace(workspaceId: string, id: string): Promise<Connector | null> {
    const row = await db.get(
      `SELECT connector_id, team_id, name, source_yaml, revision, enabled, created_at, updated_at
       FROM connectors WHERE team_id = ? AND connector_id = ?`,
      [workspaceId, id],
    );
    return row ? this.parse(row) : null;
  }

  async getRevisionForWorkspace(workspaceId: string, id: string, revision: number): Promise<string | null> {
    const row = await db.get(
      `SELECT source_yaml FROM connector_revisions
       WHERE team_id = ? AND connector_id = ? AND revision = ?`,
      [workspaceId, id, revision],
    );
    return typeof row?.source_yaml === "string" ? row.source_yaml : null;
  }

  async revokeForWorkspace(workspaceId: string, id: string): Promise<boolean> {
    const result = await db.run(
      `UPDATE connectors SET enabled = 0, webhook_token_hash = NULL, updated_at = CURRENT_TIMESTAMP
       WHERE team_id = ? AND connector_id = ? AND enabled = 1`,
      [workspaceId, id],
    );
    return Number(result?.changes || 0) > 0;
  }

  async lookupByToken(token: string): Promise<ResolvedConnector | null> {
    if (typeof token !== "string" || token.length === 0) {
      return null;
    }
    const row = await db.get(
      `SELECT connector_id, team_id, name, source_yaml, revision FROM connectors
       WHERE webhook_token_hash = ? AND enabled = 1`,
      [tokenDigest(token)],
    );
    if (!row) {
      return null;
    }
    return {
      id: row.connector_id,
      workspaceId: row.team_id,
      name: row.name,
      sourceYaml: row.source_yaml,
      version: Number(row.revision),
    };
  }

  private parse(row: any): Connector {
    return {
      id: row.connector_id,
      workspaceId: row.team_id,
      name: row.name,
      sourceYaml: row.source_yaml,
      version: Number(row.revision),
      enabled: Boolean(row.enabled),
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    };
  }
}
