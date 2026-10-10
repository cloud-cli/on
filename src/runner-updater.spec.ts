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

    expect(execute.mock.calls[0]).toEqual([
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
    ]);
    expect(execute.mock.calls[1][0]).toBe("systemd-run");
    const restartArgs = execute.mock.calls[1][1];
    expect(restartArgs).toEqual(
      expect.arrayContaining([
        "--no-block",
        "--collect",
        "--on-active=2s",
        "--property=Type=exec",
        "systemctl",
        "restart",
        "runner-worker.service",
      ]),
    );
    const restartUnit = restartArgs.find((argument) => argument.startsWith("--unit="));
    expect(restartUnit).toMatch(/^--unit=on-runner-update-restart-[0-9a-f-]{36}$/);
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

  it("rolls back if detached restart scheduling fails", async () => {
    const execute = vi
      .fn<(...args: [string, string[]]) => Promise<unknown>>()
      .mockResolvedValueOnce(undefined)
      .mockRejectedValueOnce(new Error("restart scheduling failed"))
      .mockResolvedValueOnce(undefined);
    vi.stubEnv("RUNNER_UPDATE_INSTALL_DIR", "/usr");
    vi.stubEnv("RUNNER_UPDATE_SERVICE", "runner-worker.service");

    await expect(applyRunnerUpdate("1.2.3", config("systemd-npm"), execute)).rejects.toThrow(
      "restart scheduling failed",
    );

    expect(execute).toHaveBeenCalledTimes(3);
    expect(execute.mock.calls[0][0]).toBe("npm");
    expect(execute.mock.calls[1][0]).toBe("systemd-run");
    expect(execute.mock.calls[2][0]).toBe("npm");
    expect(execute.mock.calls[2][1].at(-1)).toBe("@cloud-cli/on@0.0.0");
  });
});
