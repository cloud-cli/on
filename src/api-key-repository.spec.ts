import { beforeEach, describe, expect, it, vi } from "vitest";

const database = vi.hoisted(() => {
  const rows: any[] = [];
  const columns = ["id", "name", "key_hash", "scopes", "created_at", "last_used_at", "revoked_at"];
  const run = vi.fn(async (sql: string, params: any[] = []) => {
    if (sql.startsWith("ALTER TABLE api_keys ADD COLUMN team_id")) {
      columns.push("team_id");
      for (const row of rows) {
        row.team_id = "default";
      }
    } else if (sql.startsWith("INSERT INTO api_keys")) {
      const [id, teamId, name, key_hash, scopes] = params;
      rows.push({ id, team_id: teamId, name, key_hash, scopes, created_at: "now", revoked_at: null });
    } else if (sql.startsWith("UPDATE api_keys SET last_used_at")) {
      const row = rows.find((item) => item.id === params[0]);
      if (row) {
        row.last_used_at = "now";
      }
    } else if (sql.startsWith("UPDATE api_keys SET revoked_at")) {
      const row = rows.find((item) => item.team_id === params[0] && item.id === params[1] && !item.revoked_at);
      if (row) {
        row.revoked_at = "now";
        return { changes: 1 };
      }
      return { changes: 0 };
    }
    return { changes: 1 };
  });
  const all = vi.fn(async (sql: string, params: any[] = []) => {
    if (sql === "PRAGMA table_info(api_keys)") {
      return columns.map((name) => ({ name }));
    }
    if (sql.startsWith("SELECT id, name, scopes, created_at, last_used_at FROM api_keys")) {
      return rows.filter((row) => row.team_id === params[0] && !row.revoked_at);
    }
    return [];
  });
  const get = vi.fn(async (sql: string, params: any[] = []) => {
    if (sql.startsWith("SELECT id, scopes, team_id FROM api_keys")) {
      return rows.find((row) => row.key_hash === params[0] && !row.revoked_at) || null;
    }
    return null;
  });
  const exec = vi.fn(async () => undefined);
  return { all, columns, exec, get, rows, run };
});

vi.mock("./db-client.js", () => ({ default: database }));

import { ApiKeyRepository } from "./api-key-repository.js";

describe("workspace API-key repository", () => {
  beforeEach(() => {
    database.rows.length = 0;
    database.columns.splice(
      0,
      database.columns.length,
      "id",
      "name",
      "key_hash",
      "scopes",
      "created_at",
      "last_used_at",
      "revoked_at",
    );
    vi.clearAllMocks();
  });

  it("adds a default workspace to pre-existing API-key tables without changing existing tokens", async () => {
    const repository = new ApiKeyRepository();
    database.rows.push({
      id: "old",
      team_id: undefined,
      name: "old-key",
      key_hash: "preserved-hash",
      scopes: '["workflows:read"]',
      revoked_at: null,
    });

    await repository.init();
    await repository.init();

    expect(database.run).toHaveBeenCalledTimes(1);
    expect(database.rows[0]).toMatchObject({ id: "old", team_id: "default", key_hash: "preserved-hash" });
  });

  it("lists, resolves, and revokes keys only within their owning workspace", async () => {
    const repository = new ApiKeyRepository();
    await repository.init();
    const a = await repository.issue("workspace-a", "automation-a", ["workflows:read"]);
    const b = await repository.issue("workspace-b", "automation-b", ["runs:control"]);

    expect((await repository.list("workspace-a")).map((key) => key.name)).toEqual(["automation-a"]);
    expect(await repository.tokenDetails(a.token)).toEqual({ scopes: ["workflows:read"], teamId: "workspace-a" });
    expect(await repository.revoke("workspace-a", b.id)).toBe(false);
    expect(await repository.revoke("workspace-a", a.id)).toBe(true);
    expect(await repository.tokenDetails(a.token)).toBeNull();
    expect(await repository.scopesForToken(b.token)).toEqual(["runs:control"]);
  });

  it("assigns compatibility API keys to the default workspace", async () => {
    const repository = new ApiKeyRepository();
    await repository.init();
    const issued = await repository.issue("legacy-key", ["workflows:read"]);

    expect((await repository.tokenDetails(issued.token))?.teamId).toBe("default");
    expect((await repository.list("default")).map((key) => key.name)).toContain("legacy-key");
  });
});
