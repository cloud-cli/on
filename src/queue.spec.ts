import { afterEach, describe, expect, it, vi } from "vitest";
import { QueueManager } from "./queue.js";
import { SecretRepository } from "./secret-repository.js";

process.env.RUNNER_MASTER_KEY ||= "unit-test-runner-master-key";

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

describe("durable step attempt visibility", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("projects only unmatched starts as interrupted-or-unknown within the requested team", async () => {
    const fetchMock = vi.fn().mockResolvedValue({ ok: true, json: async () => [] });
    vi.stubGlobal("fetch", fetchMock);
    await new QueueManager("test").getStepAttemptsForTeam("team-a", 42);
    const request = JSON.parse(fetchMock.mock.calls[0][1].body);
    expect(request.s).toContain("FROM step_execution_attempt_starts s");
    expect(request.s).toContain("NOT EXISTS");
    expect(request.s).toContain("'interrupted_or_unknown' AS status");
    expect(request.d).toEqual(["team-a", 42, "team-a", 42]);
  });

  it("writes a durable start marker before step execution", async () => {
    const fetchMock = vi.fn().mockResolvedValue({ ok: true, json: async () => ({ changes: 1 }) });
    vi.stubGlobal("fetch", fetchMock);
    await new QueueManager("test").saveStepAttemptStart({
      jobId: 42,
      stepId: "build",
      attempt: 1,
      startedAt: "now",
      attemptId: "id-1",
    });
    const request = JSON.parse(fetchMock.mock.calls[0][1].body);
    expect(request.s).toContain("ON CONFLICT(job_id, step_id, attempt) DO NOTHING");
    expect(request.d).toEqual(["build", 1, "now", "id-1", 42]);
  });

  it("fails closed when an attempt start cannot be recorded", async () => {
    const fetchMock = vi.fn().mockResolvedValue({ ok: true, json: async () => ({ changes: 0 }) });
    vi.stubGlobal("fetch", fetchMock);
    await expect(
      new QueueManager("test").saveStepAttemptStart({
        jobId: 42,
        stepId: "build",
        attempt: 1,
        startedAt: "now",
        attemptId: "id-1",
      }),
    ).rejects.toThrow("refusing to execute step");
  });
});

describe("runner step attempt writes", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("completes a worker-shaped attempt after its start marker, including its snapshot", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce({ ok: true, json: async () => ({ changes: 1 }) })
      .mockResolvedValueOnce({ ok: true, json: async () => ({ changes: 1 }) });
    vi.stubGlobal("fetch", fetchMock);
    const manager = new QueueManager("test");
    const start = {
      jobId: 7,
      stepId: "build",
      attempt: 1,
      startedAt: "2026-01-01T00:00:00Z",
      attemptId: "id-1",
    };

    await expect(manager.saveStepAttemptStartForRunner(7, "runner", "lease", "hash", start)).resolves.toBe(true);
    await expect(
      manager.saveStepAttemptForRunner("runner", "lease", "hash", {
        ...start,
        status: "success",
        completedAt: "2026-01-01T00:00:01Z",
        durationMs: 1000,
        exitCode: 0,
        logContent: "build completed",
        snapshotJson: '{"version":1,"status":"captured","inputs":{}}',
      }),
    ).resolves.toBe(true);

    const completion = JSON.parse(fetchMock.mock.calls[1][1].body);
    expect(completion.s).toContain("step_execution_attempt_starts s WHERE s.job_id = jobs.id");
    expect(completion.s).toContain("s.attempt_id = ?");
    expect(completion.d).toEqual([
      "build",
      1,
      "success",
      "2026-01-01T00:00:00Z",
      "2026-01-01T00:00:01Z",
      1000,
      0,
      null,
      "build completed",
      "id-1",
      '{"version":1,"status":"captured","inputs":{}}',
      7,
      "runner",
      "lease",
      "hash",
      "build",
      1,
      "id-1",
    ]);
  });

  it.each([
    ["stale lease", false],
    ["expired lease", false],
    ["fenced lease", false],
    ["exact duplicate under current lease", true],
    ["conflicting duplicate", false],
  ])("returns %s outcome correctly", async (_case, expected) => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce({ ok: true, json: async () => ({ changes: 0 }) })
      .mockResolvedValueOnce({
        ok: true,
        json: async () => (expected ? { matched: 1 } : null),
      });
    vi.stubGlobal("fetch", fetchMock);
    const manager = new QueueManager("test");
    const result = await manager.saveStepAttemptStartForRunner(7, "runner", "lease", "hash", {
      stepId: "build",
      attempt: 1,
      startedAt: "2026-01-01T00:00:00Z",
      attemptId: "id-1",
    });
    expect(result).toBe(expected);
    expect(JSON.parse(fetchMock.mock.calls[0][1].body).s).toContain("lease_fenced = 0");
    expect(JSON.parse(fetchMock.mock.calls[1][1].body).s).toContain(
      "julianday(jobs.lease_expires_at) > julianday('now')",
    );
  });

  it("accepts a complete attempt retry only when its immutable persisted fields match", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce({ ok: true, json: async () => ({ changes: 0 }) })
      .mockResolvedValueOnce({ ok: true, json: async () => ({ matched: 1 }) });
    vi.stubGlobal("fetch", fetchMock);
    const manager = new QueueManager("test");
    const result = await manager.saveStepAttemptForRunner("runner", "lease", "hash", {
      jobId: 7,
      stepId: "build",
      attempt: 1,
      status: "success",
      startedAt: "start",
      completedAt: "done",
      durationMs: 12,
      exitCode: 0,
      logContent: "ok",
      attemptId: "id-1",
      snapshotJson: '{"version":1,"status":"captured","inputs":{}}',
    });
    expect(result).toBe(true);
    const duplicateCheck = JSON.parse(fetchMock.mock.calls[1][1].body);
    expect(duplicateCheck.s).toContain("a.duration_ms = ?");
    expect(duplicateCheck.s).toContain("a.log_content = ?");
    expect(duplicateCheck.s).toContain("a.snapshot_json IS ?");
    const insert = JSON.parse(fetchMock.mock.calls[0][1].body);
    expect(insert.s).toContain("snapshot_json");
    expect(insert.d).toContain('{"version":1,"status":"captured","inputs":{}}');
    expect(duplicateCheck.s).toContain("jobs.lease_fenced = 0");
  });
});

describe("QueueManager.enqueueDispatch", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("uses a stable unique source-step key and returns the existing job on retry", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce({ json: async () => ({ lastInsertRowid: 0 }) })
      .mockResolvedValueOnce({ json: async () => ({ id: 71 }) });
    vi.stubGlobal("fetch", fetchMock);
    const id = await new QueueManager("test").enqueueDispatch(
      "downstream",
      3,
      { inputs: { value: { ok: true } } },
      [],
      "team-a",
      12,
      "dispatch:12:handoff",
    );
    expect(id).toBe(71);
    const [insertRequest, lookupRequest] = fetchMock.mock.calls;
    const insert = JSON.parse(String(insertRequest[1].body));
    expect(insert.s).toContain("ON CONFLICT(dispatch_key) DO NOTHING");
    expect(insert.s).toContain("rv.revoked = 1");
    expect(insert.d).toContain("dispatch:12:handoff");
    expect(insert.d[4]).toMatch(/^enc:v1:/);
    expect(new SecretRepository().decryptValue(insert.d[4].slice("enc:v1:".length))).toBe(
      JSON.stringify({ inputs: { value: { ok: true } } }),
    );
    expect(JSON.parse(String(lookupRequest[1].body)).s).toContain("WHERE dispatch_key = ? AND team_id = ?");
  });

  it("does not enqueue jobs after workspace deletion has begun", async () => {
    const fetchMock = vi.fn().mockResolvedValue({ json: async () => ({ lastInsertRowid: 0 }) });
    vi.stubGlobal("fetch", fetchMock);

    await expect(new QueueManager("test").enqueue("flow", 1, { inputs: {} })).rejects.toThrow("being deleted");

    const request = JSON.parse(String(fetchMock.mock.calls[0][1].body));
    expect(request.s).toContain("JOIN teams ON teams.id = workflows.team_id");
    expect(request.s).toContain("teams.deleting_at IS NULL");
    expect(request.s).toContain("rv.revoked = 1");
    expect(request.d.at(-2)).toBe("flow");
    expect(request.d.at(-1)).toBe(1);
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

  it("decrypts new encrypted payloads and preserves legacy plaintext rows", async () => {
    const payload = { inputs: { note: "private" } };
    const encrypted = `enc:v1:${new SecretRepository().encryptValue(JSON.stringify(payload))}`;
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({ id: 1, payload: encrypted }),
      })
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({ id: 2, payload: JSON.stringify(payload) }),
      });
    vi.stubGlobal("fetch", fetchMock);

    await expect(new QueueManager("worker").claimNextJob()).resolves.toMatchObject({
      id: 1,
      payload,
    });
    await expect(new QueueManager("worker").claimNextJob()).resolves.toMatchObject({
      id: 2,
      payload,
    });
  });
});

describe("QueueManager.listJobsForTeam", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("does not select job payloads for API-facing listings", async () => {
    const fetchMock = vi.fn().mockResolvedValue({ ok: true, json: async () => [] });
    vi.stubGlobal("fetch", fetchMock);
    await new QueueManager("test").listJobsForTeam("team-a");
    const request = JSON.parse(fetchMock.mock.calls[0][1].body);
    expect(request.s).not.toContain("payload");
  });

  it("filters encrypted inputs without returning their payload or interpreting regex syntax", async () => {
    const serialize = (inputs: Record<string, unknown>) =>
      `enc:v1:${new SecretRepository().encryptValue(JSON.stringify({ inputs }))}`;
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => [
        { id: 8, payload: serialize({ note: "release[blue]" }) },
        { id: 7, payload: serialize({ note: "release-blue" }) },
      ],
    });
    vi.stubGlobal("fetch", fetchMock);

    await expect(
      new QueueManager("test").listJobsForTeam("team-a", 10, undefined, undefined, "note:release[blue]"),
    ).resolves.toEqual([{ id: 8 }]);
  });
});

describe("QueueManager job lookups", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("decrypts encrypted payloads on authorized detail and leased-job retrieval", async () => {
    const payload = { inputs: { token: "sensitive" } };
    const stored = `enc:v1:${new SecretRepository().encryptValue(JSON.stringify(payload))}`;
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ id: 7, payload: stored }),
    });
    vi.stubGlobal("fetch", fetchMock);
    const queue = new QueueManager("test");

    await expect(queue.getJobForTeam("team-a", 7)).resolves.toMatchObject({
      id: 7,
      payload,
    });
    await expect(queue.getLeasedJob("lease", "runner", "hash")).resolves.toMatchObject({
      id: 7,
      payload,
    });
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
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => [{ jobId: 8, teamId: "team-a", leaseId: "lease-1" }],
    });
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
    expect(request.s).toContain("rv.revoked = 1");
    expect(request.s).toContain("team_id");
    expect(request.s).toContain("WHERE jobs.id = ? AND teams.deleting_at IS NULL");
    expect(request.d[0]).toBe(7);
    expect(request.d[1]).toMatch(/^enc:v1:/);
    expect(request.d[2]).toBe(42);
    expect(request.d[3]).toBe(7);
  });
});
