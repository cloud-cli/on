import { EventEmitter } from "node:events";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
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
    child = Object.assign(new EventEmitter(), {
      stdout: new EventEmitter(),
      stderr: new EventEmitter(),
    });
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
      secretFilesDir: join(tempDirectory, "secrets"),
      logsDir: join(tempDirectory, "logs"),
      env: { WORKING_DIR: hostWorkingDir, CI: "true" },
      image: "node:22",
    } as any);

    const args = spawnMock.mock.calls[0][1] as string[];
    const systemdEnv = args.filter((arg) => arg.startsWith("--setenv=WORKING_DIR="));
    expect(systemdEnv).toEqual(["--setenv=WORKING_DIR=/workspace"]);
    expect(args.some((arg) => arg.startsWith("--setenv=HOME="))).toBe(true);
    expect(args).toContain("--quiet");
    expect(args).toContain("-w");
    expect(args).toContain("/workspace");
    expect(args).toContain(`${join(tempDirectory, "secrets")}:${join(tempDirectory, "secrets")}:ro`);
    expect(args).toContain("-e");
    expect(args).toContain("WORKING_DIR");
    expect(args).not.toContain("HOME");
    expect(args).toContain('if [ -z "${HOME:-}" ]; then HOME=/root; fi; export HOME; exec /bin/sh -e -c "$1"');

    child.emit("close", 0, null);
    await handle.done;
  });

  it("suppresses systemd-run footers without dropping step diagnostics", async () => {
    const handle = new SystemdDriver().execute({
      jobId: "43",
      step: { id: "diagnostic" },
      command: "echo diagnostic >&2",
      workingDir: join(tempDirectory, "worker", "wd"),
      logsDir: join(tempDirectory, "logs"),
      env: {},
    } as any);

    expect(spawnMock.mock.calls[0][1]).toContain("--quiet");
    child.stderr.emit("data", Buffer.from("step diagnostic\n"));
    child.emit("close", 0, null);
    await handle.done;

    expect(await new SystemdDriver().readLog(handle.logFilePath)).toMatch(/\] step diagnostic\n$/);
  });
});

describe("systemd driver log cleanup", () => {
  it("removes wrapper and usage lines across appended attempts, including partial attempts", async () => {
    const directory = mkdtempSync(join(tmpdir(), "systemd-log-test-"));
    const file = join(directory, "step.log");
    writeFileSync(
      file,
      "[2026-01-01T00:00:00.000Z] Running as unit: old.service\nfirst stdout\n[2026-01-01T00:00:01.000Z] Finished with result: exit-code\n[2026-01-01T00:00:01.000Z] CPU time consumed: 1.2s\n[2026-01-01T00:00:01.000Z] Memory peak: 20M\n[2026-01-02T00:00:00.000Z] Running as unit: new.service\nsecond stderr\n[2026-01-02T00:00:01.000Z] CPU time consumed: 2s\n[2026-01-02T00:00:02.000Z] Finished with result: success\nthird output\n[2026-01-03T00:00:00.000Z] Running as unit: partial.service\npartial output\n[2026-01-03T00:00:01.000Z] Memory peak: 4M\n",
    );
    try {
      expect(await new SystemdDriver().readLog(file)).toBe(
        "first stdout\nsecond stderr\nthird output\npartial output\n",
      );
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it("preserves ordinary user text containing wrapper phrases", async () => {
    const directory = mkdtempSync(join(tmpdir(), "systemd-log-test-"));
    const file = join(directory, "step.log");
    writeFileSync(file, "user says Running as unit: example\nFinished with result: useful text\n");
    try {
      expect(await new SystemdDriver().readLog(file)).toBe(
        "user says Running as unit: example\nFinished with result: useful text\n",
      );
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });
});
