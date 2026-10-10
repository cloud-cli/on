import crypto from "node:crypto";
import db from "./db-client.js";

export type RunnerScope = "shared" | "team";
export type RunnerRecord = {
  id: string;
  name: string;
  scope: RunnerScope;
  teamId: string | null;
  runtime: string;
  version: string;
  capabilities: string[];
  concurrency: number;
  activeJobs: number;
  lastSeen: string | null;
  status: "available" | "online" | "offline" | "revoked";
  desiredVersion: string | null;
};

const digest = (token: string) => crypto.createHash("sha256").update(token).digest("hex");
const random = (bytes = 32) => crypto.randomBytes(bytes).toString("base64url");

/** Coordinator-owned runner identities, one-time enrollment codes, and team grants. */
export class RunnerRegistry {
  async init(): Promise<void> {
    await db.exec(`
      CREATE TABLE IF NOT EXISTS runners (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        scope TEXT NOT NULL CHECK (scope IN ('shared', 'team')),
        team_id TEXT,
        token_hash TEXT NOT NULL UNIQUE,
        runtime TEXT NOT NULL DEFAULT 'unknown',
        version TEXT NOT NULL DEFAULT 'unknown',
        capabilities TEXT NOT NULL DEFAULT '[]',
        concurrency INTEGER NOT NULL DEFAULT 1,
        active_jobs INTEGER NOT NULL DEFAULT 0,
        status TEXT NOT NULL DEFAULT 'offline',
        desired_version TEXT,
        current_update_id TEXT,
        last_seen DATETIME,
        revoked_at DATETIME,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP
      );
      CREATE TABLE IF NOT EXISTS runner_enrollments (
        id TEXT PRIMARY KEY,
        code_hash TEXT NOT NULL UNIQUE,
        scope TEXT NOT NULL CHECK (scope IN ('shared', 'team')),
        team_id TEXT,
        created_by TEXT NOT NULL,
        expires_at DATETIME NOT NULL,
        redeemed_at DATETIME,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP
      );
      CREATE TABLE IF NOT EXISTS runner_team_grants (
        runner_id TEXT NOT NULL,
        team_id TEXT NOT NULL,
        created_by TEXT NOT NULL,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        PRIMARY KEY (runner_id, team_id),
        FOREIGN KEY (runner_id) REFERENCES runners(id) ON DELETE CASCADE
      );
      CREATE INDEX IF NOT EXISTS idx_runner_enrollments_expiry ON runner_enrollments(expires_at, redeemed_at);
      CREATE INDEX IF NOT EXISTS idx_runner_grants_team ON runner_team_grants(team_id, runner_id);
    `);
  }

  async createEnrollment(scope: RunnerScope, teamId: string | null, createdBy: string, ttlMs = 10 * 60_000) {
    if (scope === "team" && !teamId) throw new Error("Team-scoped enrollment requires a team");
    if (scope === "shared" && teamId) throw new Error("Shared enrollment cannot be bound to a team");
    if (!Number.isSafeInteger(ttlMs) || ttlMs < 60_000 || ttlMs > 60 * 60_000) {
      throw new Error("Enrollment expiry must be between one minute and one hour");
    }
    const code = random();
    const id = random(18);
    const expiresAt = new Date(Date.now() + ttlMs).toISOString();
    await db.run(
      `INSERT INTO runner_enrollments (id, code_hash, scope, team_id, created_by, expires_at)
       VALUES (?, ?, ?, ?, ?, ?)`,
      [id, digest(code), scope, teamId, createdBy, expiresAt],
    );
    return { id, code, expiresAt };
  }

  async redeemEnrollment(code: string, name: string, runtime = "unknown") {
    if (!code || code.length > 200) return null;
    const normalizedName = name.trim();
    if (!normalizedName || normalizedName.length > 100) throw new Error("Runner name must be 1–100 characters");
    const id = random(18);
    const credential = `onr_${random()}`;
    // Single conditional UPDATE makes code redemption one-use under concurrent requests.
    const enrollment = await db.get(
      `UPDATE runner_enrollments SET redeemed_at = CURRENT_TIMESTAMP
       WHERE code_hash = ? AND redeemed_at IS NULL AND julianday(expires_at) > julianday('now')
       RETURNING scope, team_id`,
      [digest(code)],
    );
    if (!enrollment) return null;
    await db.run(
      `INSERT INTO runners (id, name, scope, team_id, token_hash, runtime, status)
       VALUES (?, ?, ?, ?, ?, ?, 'offline')`,
      [id, normalizedName, enrollment.scope, enrollment.team_id, digest(credential), runtime.slice(0, 100)],
    );
    if (enrollment.scope === "shared") {
      // Shared runner is registered but not authorized for any team's workload until explicitly granted.
    }
    return {
      runnerId: id,
      credential,
      scope: enrollment.scope as RunnerScope,
      teamId: enrollment.team_id as string | null,
    };
  }

  async authenticate(
    credential: string,
  ): Promise<{ runnerId: string; scope: RunnerScope; teamId: string | null } | null> {
    if (!credential || credential.length > 256) return null;
    const row = await db.get(`SELECT id, scope, team_id FROM runners WHERE token_hash = ? AND revoked_at IS NULL`, [
      digest(credential),
    ]);
    return row ? { runnerId: row.id, scope: row.scope, teamId: row.team_id } : null;
  }

  async heartbeat(
    runnerId: string,
    report: { runtime?: string; version?: string; capabilities?: unknown; concurrency?: number; activeJobs?: number },
  ): Promise<boolean> {
    const capabilities = Array.isArray(report.capabilities)
      ? [
          ...new Set(
            report.capabilities
              .filter((item): item is string => typeof item === "string")
              .map((item) => item.trim().slice(0, 100))
              .filter(Boolean),
          ),
        ].slice(0, 100)
      : [];
    const result = await db.run(
      `UPDATE runners SET runtime = ?, version = ?, capabilities = ?, concurrency = ?, active_jobs = ?,
       last_seen = CURRENT_TIMESTAMP, status = CASE WHEN current_update_id IS NULL THEN 'online' ELSE status END
       WHERE id = ? AND revoked_at IS NULL`,
      [
        String(report.runtime || "unknown").slice(0, 100),
        String(report.version || "unknown").slice(0, 100),
        JSON.stringify(capabilities),
        clampInteger(report.concurrency, 1, 1000, 1),
        clampInteger(report.activeJobs, 0, 1000, 0),
        runnerId,
      ],
    );
    return Number(result?.changes || 0) === 1;
  }

  async list(): Promise<RunnerRecord[]> {
    const rows = await db.all(
      `SELECT id, name, scope, team_id, runtime, version, capabilities, concurrency, active_jobs,
       last_seen, status, desired_version FROM runners WHERE revoked_at IS NULL ORDER BY created_at DESC`,
    );
    return rows.map((row: any) => ({
      id: row.id,
      name: row.name,
      scope: row.scope,
      teamId: row.team_id,
      runtime: row.runtime,
      version: row.version,
      capabilities: JSON.parse(row.capabilities || "[]"),
      concurrency: row.concurrency,
      activeJobs: row.active_jobs,
      lastSeen: row.last_seen,
      status: row.last_seen
        ? Date.now() - Date.parse(`${row.last_seen}Z`) < 45_000
          ? "online"
          : "offline"
        : row.status,
      desiredVersion: row.desired_version,
    }));
  }

  async listForTeam(
    teamId: string,
  ): Promise<{ team: RunnerRecord[]; shared: RunnerRecord[]; available: RunnerRecord[] }> {
    const runners = await this.list();
    const grants = await db.all("SELECT runner_id FROM runner_team_grants WHERE team_id = ?", [teamId]);
    const grantedIds = new Set(grants.map((row: any) => row.runner_id));
    const shared = runners.filter((runner) => runner.scope === "shared");
    return {
      team: runners.filter((runner) => runner.scope === "team" && runner.teamId === teamId),
      shared: shared.filter((runner) => grantedIds.has(runner.id)),
      available: shared.filter((runner) => !grantedIds.has(runner.id)),
    };
  }

  async grantTeam(runnerId: string, teamId: string, actor: string): Promise<boolean> {
    const runner = await db.get("SELECT scope FROM runners WHERE id = ? AND revoked_at IS NULL", [runnerId]);
    if (!runner || runner.scope !== "shared") return false;
    await db.run("INSERT OR IGNORE INTO runner_team_grants (runner_id, team_id, created_by) VALUES (?, ?, ?)", [
      runnerId,
      teamId,
      actor,
    ]);
    return true;
  }

  async revokeTeamGrant(runnerId: string, teamId: string): Promise<boolean> {
    const result = await db.run("DELETE FROM runner_team_grants WHERE runner_id = ? AND team_id = ?", [
      runnerId,
      teamId,
    ]);
    return Number(result?.changes || 0) > 0;
  }

  async teamsForRunner(runnerId: string): Promise<string[]> {
    const runner = await db.get("SELECT scope, team_id FROM runners WHERE id = ? AND revoked_at IS NULL", [runnerId]);
    if (!runner) return [];
    if (runner.scope === "team") return [runner.team_id];
    const rows = await db.all("SELECT team_id FROM runner_team_grants WHERE runner_id = ? ORDER BY team_id", [
      runnerId,
    ]);
    return rows.map((row: any) => row.team_id);
  }

  async claimContext(runnerId: string): Promise<{ tags: string[]; teamIds: string[]; concurrency: number } | null> {
    const runner = await db.get(
      "SELECT scope, team_id, capabilities, concurrency FROM runners WHERE id = ? AND revoked_at IS NULL",
      [runnerId],
    );
    if (!runner) return null;
    return {
      tags: JSON.parse(runner.capabilities || "[]"),
      teamIds: await this.teamsForRunner(runnerId),
      concurrency: runner.concurrency,
    };
  }

  async revoke(runnerId: string): Promise<boolean> {
    const result = await db.run(
      `UPDATE runners SET revoked_at = CURRENT_TIMESTAMP, status = 'revoked', token_hash = ?
       WHERE id = ? AND revoked_at IS NULL`,
      [digest(random()), runnerId],
    );
    return Number(result?.changes || 0) === 1;
  }
}

function clampInteger(value: unknown, min: number, max: number, fallback: number): number {
  const number = Number(value);
  return Number.isSafeInteger(number) ? Math.max(min, Math.min(max, number)) : fallback;
}
