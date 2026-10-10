import { execFile as nodeExecFile } from "node:child_process";
import { promisify } from "node:util";
import { isAbsolute } from "node:path";
import type { RunnerConfig } from "./types.js";
import { isExactSemver } from "./semver.js";
import { RUNNER_VERSION } from "./version.js";

const execFile = promisify(nodeExecFile);
export type CommandExecutor = (command: string, args: string[]) => Promise<unknown>;

function configuredSystemdUpdater(config: RunnerConfig): boolean {
  const installDir = process.env.RUNNER_UPDATE_INSTALL_DIR || "";
  const serviceUnit = process.env.RUNNER_UPDATE_SERVICE || "";
  return (
    config.runnerUpdateAdapter === "systemd-npm" &&
    isAbsolute(installDir) &&
    /^[A-Za-z0-9_.@:-]+\.service$/.test(serviceUnit)
  );
}

/** Apply only the explicitly configured, allowlisted systemd + npm package updater. */
export async function applyRunnerUpdate(
  version: string,
  config: RunnerConfig,
  execute: CommandExecutor = async (command, args) =>
    execFile(command, args, { timeout: 10 * 60_000, maxBuffer: 2_000_000 }),
): Promise<void> {
  if (!isExactSemver(version)) throw new Error("Runner update version must be exact semantic version");
  if (config.runnerUpdateAdapter !== "systemd-npm") {
    throw new Error("No supported runner update adapter is configured");
  }
  const installDir = process.env.RUNNER_UPDATE_INSTALL_DIR || "";
  const serviceUnit = process.env.RUNNER_UPDATE_SERVICE || "";
  if (!isAbsolute(installDir)) throw new Error("RUNNER_UPDATE_INSTALL_DIR must be an absolute path");
  if (!/^[A-Za-z0-9_.@:-]+\.service$/.test(serviceUnit)) {
    throw new Error("RUNNER_UPDATE_SERVICE must be a valid systemd service unit name");
  }

  const installArgs = (targetVersion: string) => [
    "install",
    "--global",
    "--ignore-scripts",
    "--registry=https://registry.npmjs.org/",
    "--prefix",
    installDir,
    `@cloud-cli/on@${targetVersion}`,
  ];
  try {
    await execute("npm", installArgs(version));
    await execute("systemctl", ["--no-block", "restart", serviceUnit]);
  } catch (error) {
    try {
      if (!isExactSemver(RUNNER_VERSION))
        throw new Error("Current runner version is not a releasable semantic version");
      await execute("npm", installArgs(RUNNER_VERSION));
    } catch (rollbackError) {
      throw new AggregateError([error, rollbackError], "Runner update and rollback both failed");
    }
    throw error;
  }
}

export function runnerUpdateCapabilities(config: RunnerConfig): string[] {
  return configuredSystemdUpdater(config) ? ["updater"] : [];
}
