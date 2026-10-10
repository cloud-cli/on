import { afterEach, describe, expect, it, vi } from "vitest";
import { QueueManager } from "./queue.js";

vi.mock("./db-client.js", () => {
  const query = (method: string, statement: string, data?: unknown[]) =>
    fetch("http://database.test/query", {
      method: "POST",
      body: JSON.stringify({ s: statement, d: data, m: method }),
    }).then((response) => response.json());
  return {
    default: {
      get: query.bind(null, "get"),
      run: query.bind(null, "run"),
      all: query.bind(null, "all"),
      exec: query.bind(null, "exec"),
    },
  };
});

describe("QueueManager.listJobs", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("optionally requests jobs between inclusive and exclusive ID cursors", async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => [],
    });
    vi.stubGlobal("fetch", fetchMock);

    await new QueueManager("test").listJobs(51, 42, 100);

    const request = JSON.parse(fetchMock.mock.calls[0][1].body);
    expect(request).toMatchObject({
      m: "all",
      s: "SELECT * FROM jobs WHERE id > ? AND id < ? ORDER BY id DESC LIMIT ?;",
      d: [42, 100, 51],
    });
  });

  it("filters shallow trigger fields with glob syntax", async () => {
    const fetchMock = vi.fn().mockResolvedValue({ ok: true, json: async () => [] });
    vi.stubGlobal("fetch", fetchMock);

    await new QueueManager("test").listJobs(51, undefined, undefined, "name:cloud-cli/*");

    const request = JSON.parse(fetchMock.mock.calls[0][1].body);
    expect(request.s).toContain("json_extract(payload, '$.inputs.' || ?) GLOB ?");
    expect(request.d).toEqual(["name", "cloud-cli/*", 51]);
  });

  it("searches serialized trigger inputs when no field is specified", async () => {
    const fetchMock = vi.fn().mockResolvedValue({ ok: true, json: async () => [] });
    vi.stubGlobal("fetch", fetchMock);

    await new QueueManager("test").listJobs(51, undefined, undefined, "cloud-cli");

    const request = JSON.parse(fetchMock.mock.calls[0][1].body);
    expect(request.s).toContain("LOWER(payload) LIKE LOWER(?)");
    expect(request.d).toEqual(["%cloud-cli%", 51]);
  });
});

describe("QueueManager.claimNextJob", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("atomically claims only jobs whose required tags are all supported", async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => null,
    });
    vi.stubGlobal("fetch", fetchMock);

    await new QueueManager("build-node").claimNextJob(["linux", "docker"]);

    const request = JSON.parse(fetchMock.mock.calls[0][1].body);
    expect(request.m).toBe("get");
    expect(request.s).toContain("json_each(COALESCE(jobs.required_tags, '[]'))");
    expect(request.s).toContain("required_tag.value NOT IN (SELECT value FROM json_each(?))");
    expect(request.d).toEqual(["build-node", '["linux","docker"]']);
  });
});

describe("API runner lease fencing", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("claims only within granted teams and the runner concurrency ceiling", async () => {
    const fetchMock = vi.fn().mockResolvedValue({ ok: true, json: async () => ({ id: 8 }) });
    vi.stubGlobal("fetch", fetchMock);

    await new QueueManager("runner-1").claimNextForRunner("runner-1", ["linux"], ["team-a"], "lease-1", "hash", 90, 2);

    const query = JSON.parse(fetchMock.mock.calls[0][1].body);
    expect(query.s).toContain("team_id IN (SELECT value FROM json_each(?))");
    expect(query.s).toContain("claiming_runner.revoked_at IS NULL");
    expect(query.s).toContain("active.worker_id = ?");
    expect(query.s).toContain("lease_fenced = 0");
    expect(query.d).toEqual([
      "runner-1",
      "lease-1",
      "hash",
      "+90 seconds",
      '["team-a"]',
      "runner-1",
      "runner-1",
      2,
      '["linux"]',
    ]);
  });

  it("fences active jobs instead of making them immediately claimable on revocation", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValue({ ok: true, json: async () => [{ jobId: 8, teamId: "team-a", leaseId: "lease-1" }] });
    vi.stubGlobal("fetch", fetchMock);

    await expect(new QueueManager("runner-1").revokeRunnerLeases("runner-1")).resolves.toEqual([
      { jobId: 8, teamId: "team-a", leaseId: "lease-1" },
    ]);
    const query = JSON.parse(fetchMock.mock.calls[0][1].body);
    expect(query.s).toContain("status = 'cancelled', lease_fenced = 1");
    expect(query.s).not.toContain("status = 'pending'");
    expect(query.s).toContain("RETURNING id AS jobId");
  });

  it("eventually frees capacity for a cancelled job whose runner lease expired", async () => {
    const fetchMock = vi.fn().mockResolvedValue({ ok: true, json: async () => ({ changes: 1 }) });
    vi.stubGlobal("fetch", fetchMock);

    await new QueueManager("runner-1").clearStaleJobs();

    const cancellationCleanup = JSON.parse(fetchMock.mock.calls[0][1].body);
    expect(cancellationCleanup.s).toContain("SET lease_completed = 1");
    expect(cancellationCleanup.s).toContain("status = 'cancelled' AND lease_fenced = 0");
    const staleCleanup = JSON.parse(fetchMock.mock.calls[1][1].body);
    expect(staleCleanup.s).toContain("status = 'cancelled' AND lease_fenced = 1");
  });
});

describe("QueueManager.restartJob", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("copies the job definition and payload into a clean pending attempt", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({ id: 42, status: "success" }),
      })
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({ active_revision: 7 }),
      })
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({ id: 43 }),
      });
    vi.stubGlobal("fetch", fetchMock);

    await expect(new QueueManager("test").restartJob(42)).resolves.toBe(43);

    const request = JSON.parse(fetchMock.mock.calls[2][1].body);
    expect(request.m).toBe("get");
    expect(request.s).toContain("'pending', NULL, NULL, NULL, NULL");
    expect(request.s).toContain("team_id");
    expect(request.s).toContain("WHERE id = ?");
    expect(request.d).toEqual([7, JSON.stringify({ inputs: {} }), 42]);
  });
});
