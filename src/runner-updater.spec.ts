import { afterEach, describe, expect, it, vi } from "vitest";
import { applyRunnerUpdate, runnerUpdateCapabilities } from "./runner-updater.js";
import type { RunnerConfig } from "./types.js";

const config = (runnerUpdateAdapter?: string) => ({ runnerUpdateAdapter }) as RunnerConfig;

describe("systemd npm runner updater", () => {
  afterEach(() => vi.unstubAllEnvs());
  it("is capability-gated and installs the exact requested version before restarting one unit", async () => {
    const execute = vi.fn(async () => undefined);
    vi.stubEnv("RUNNER_UPDATE_INSTALL_DIR", "/usr");
    vi.stubEnv("RUNNER_UPDATE_SERVICE", "runner-worker.service");

    expect(runnerUpdateCapabilities(config("systemd-npm"))).toEqual(["updater"]);
    expect(runnerUpdateCapabilities(config())).toEqual([]);
    await applyRunnerUpdate("1.2.3", config("systemd-npm"), execute);

    expect(execute.mock.calls).toEqual([
      [
        "npm",
        [
          "install",
          "--global",
          "--ignore-scripts",
          "--registry=https://registry.npmjs.org/",
          "--prefix",
          "/usr",
          "@cloud-cli/on@1.2.3",
        ],
      ],
      ["systemctl", ["--no-block", "restart", "runner-worker.service"]],
    ]);
  });

  it("rejects ranges, arbitrary adapters, and invalid service settings", async () => {
    const execute = vi.fn(async () => undefined);
    await expect(applyRunnerUpdate("latest", config("systemd-npm"), execute)).rejects.toThrow("exact semantic");
    await expect(applyRunnerUpdate("01.2.3", config("systemd-npm"), execute)).rejects.toThrow("exact semantic");
    await expect(applyRunnerUpdate("1.2.3-01", config("systemd-npm"), execute)).rejects.toThrow("exact semantic");
    await expect(applyRunnerUpdate("1.2.3", config(), execute)).rejects.toThrow("No supported");
    vi.stubEnv("RUNNER_UPDATE_INSTALL_DIR", "/usr");
    vi.stubEnv("RUNNER_UPDATE_SERVICE", "attacker;systemctl.service");
    await expect(applyRunnerUpdate("1.2.3", config("systemd-npm"), execute)).rejects.toThrow("valid systemd");
    expect(execute).not.toHaveBeenCalled();
  });

  it("does not restart after install failure and attempts to restore the running release", async () => {
    const execute = vi
      .fn<(...args: [string, string[]]) => Promise<unknown>>()
      .mockRejectedValueOnce(new Error("install failed"))
      .mockResolvedValueOnce(undefined);
    vi.stubEnv("RUNNER_UPDATE_INSTALL_DIR", "/usr");
    vi.stubEnv("RUNNER_UPDATE_SERVICE", "runner-worker.service");

    await expect(applyRunnerUpdate("1.2.3", config("systemd-npm"), execute)).rejects.toThrow("install failed");

    expect(execute).toHaveBeenCalledTimes(2);
    expect(execute.mock.calls[1][0]).toBe("npm");
    expect(execute.mock.calls[1][1].at(-1)).toBe("@cloud-cli/on@0.0.0");
  });
});
