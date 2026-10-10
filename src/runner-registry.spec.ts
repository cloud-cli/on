import { beforeEach, describe, expect, it, vi } from "vitest";

const db = vi.hoisted(() => ({
  exec: vi.fn(),
  get: vi.fn(),
  run: vi.fn(),
  all: vi.fn(),
}));
vi.mock("./db-client.js", () => ({ default: db }));

import { RunnerRegistry } from "./runner-registry.js";

describe("RunnerRegistry", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    db.exec.mockResolvedValue(undefined);
    db.run.mockResolvedValue({ changes: 1 });
    db.all.mockResolvedValue([]);
  });

  it("persists enrollment codes and runner credentials as hashes", async () => {
    const registry = new RunnerRegistry();
    await registry.init();
    const enrollment = await registry.createEnrollment("shared", null, "admin-1");
    const enrollmentInsert = db.run.mock.calls.find(([sql]) => String(sql).includes("INSERT INTO runner_enrollments"));
    expect(enrollment.code).toHaveLength(43);
    expect(enrollmentInsert[0]).toContain("INSERT INTO runner_enrollments");
    expect(enrollmentInsert[1][1]).not.toBe(enrollment.code);

    db.get.mockResolvedValueOnce({ scope: "shared", team_id: null });
    const provisioned = await registry.redeemEnrollment(enrollment.code, "garage-runner", "systemd");
    expect(provisioned).toMatchObject({ scope: "shared", teamId: null });
    expect(provisioned?.credential).toMatch(/^onr_/);
    const runnerInsert = db.run.mock.calls.find(([sql]) => String(sql).includes("INSERT INTO runners"));
    expect(runnerInsert[0]).toContain("INSERT INTO runners");
    expect(runnerInsert[1][4]).not.toBe(provisioned?.credential);
  });

  it("requires team scope to have a team and rejects invalid expiry", async () => {
    const registry = new RunnerRegistry();
    await expect(registry.createEnrollment("team", null, "admin-1")).rejects.toThrow("requires a team");
    await expect(registry.createEnrollment("shared", null, "admin-1", 1000)).rejects.toThrow("between one minute");
    expect(db.run).not.toHaveBeenCalled();
  });

  it("redeems an enrollment with one conditional update and rejects unknown codes", async () => {
    const registry = new RunnerRegistry();
    db.get.mockResolvedValueOnce(null);
    await expect(registry.redeemEnrollment("bad-code", "runner")).resolves.toBeNull();
    expect(db.get.mock.calls[0][0]).toContain("redeemed_at IS NULL");
    expect(db.run).not.toHaveBeenCalled();
  });

  it("accepts only exact semantic versions for updates", async () => {
    const registry = new RunnerRegistry();
    await expect(registry.requestUpdate("runner-1", "latest")).rejects.toThrow("exact semantic version");
    await expect(registry.requestUpdate("runner-1", "^1.2.3")).rejects.toThrow("exact semantic version");
    expect(db.get).not.toHaveBeenCalled();
  });

  it("atomically requests updates only for idle online updater-capable runners", async () => {
    const registry = new RunnerRegistry();
    db.get.mockResolvedValueOnce({
      id: "runner-1",
    });
    await expect(registry.requestUpdate("runner-1", "1.2.3")).resolves.toMatchObject({
      runnerId: "runner-1",
      version: "1.2.3",
      status: "pending",
    });
    expect(db.get.mock.calls[0][0]).toContain("value = 'updater'");
    expect(db.get.mock.calls[0][0]).toContain("current_update_id IS NULL");
    expect(db.get.mock.calls[0][0]).toContain("active_jobs = 0");
    expect(db.run.mock.calls.find(([sql]) => String(sql).includes("INSERT INTO runner_updates"))?.[0]).toContain(
      "INSERT INTO runner_updates",
    );
  });

  it("clears its runner reservation if the update record insert fails", async () => {
    const registry = new RunnerRegistry();
    db.get.mockResolvedValueOnce({ id: "runner-1" });
    db.run.mockResolvedValueOnce({ changes: 1 });
    db.run.mockResolvedValueOnce({ changes: 1 });
    db.run.mockRejectedValueOnce(new Error("insert failed"));
    await expect(registry.requestUpdate("runner-1", "1.2.3")).rejects.toThrow("insert failed");
    expect(db.run.mock.calls.at(-1)?.[0]).toContain("current_update_id = NULL");
  });

  it("recovers update reservations left without a pending update row", async () => {
    const registry = new RunnerRegistry();
    db.get.mockResolvedValueOnce(null);

    await expect(registry.currentUpdate("runner-1")).resolves.toBeNull();

    expect(db.run.mock.calls[1][0]).toContain("current_update_id NOT IN");
    expect(db.run.mock.calls[1][0]).toContain("status = 'pending'");
  });
});
