import { EventEmitter } from "node:events";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const spawnMock = vi.hoisted(() => vi.fn());
vi.mock("node:child_process", () => ({ spawn: spawnMock, exec: vi.fn() }));

import { SystemdDriver } from "./systemd.driver.js";

describe("systemd driver container environment", () => {
  let tempDirectory: string;
  let child: EventEmitter & { stdout: EventEmitter; stderr: EventEmitter };

  beforeEach(() => {
    tempDirectory = mkdtempSync(join(tmpdir(), "systemd-driver-test-"));
    child = Object.assign(new EventEmitter(), { stdout: new EventEmitter(), stderr: new EventEmitter() });
    spawnMock.mockReturnValue(child);
  });

  afterEach(() => {
    rmSync(tempDirectory, { recursive: true, force: true });
    vi.clearAllMocks();
  });

  it("passes the container working directory rather than the host bind path", async () => {
    const hostWorkingDir = join(tempDirectory, "worker", "wd");
    const handle = new SystemdDriver().execute({
      jobId: "42",
      step: { id: "build" },
      command: "printf '%s' \"$WORKING_DIR\"",
      workingDir: hostWorkingDir,
      logsDir: join(tempDirectory, "logs"),
      env: { WORKING_DIR: hostWorkingDir, CI: "true" },
      image: "node:22",
    } as any);

    const args = spawnMock.mock.calls[0][1] as string[];
    const systemdEnv = args.filter((arg) => arg.startsWith("--setenv=WORKING_DIR="));
    expect(systemdEnv).toEqual(["--setenv=WORKING_DIR=/workspace"]);
    expect(args.some((arg) => arg.startsWith("--setenv=HOME="))).toBe(true);
    expect(args).toContain("-w");
    expect(args).toContain("/workspace");
    expect(args).toContain("-e");
    expect(args).toContain("WORKING_DIR");
    expect(args).not.toContain("HOME");
    expect(args).toContain('if [ -z "${HOME:-}" ]; then HOME=/root; fi; export HOME; exec /bin/sh -e -c "$1"');

    child.emit("close", 0, null);
    await handle.done;
  });
});
