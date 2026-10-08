import { EventEmitter } from "node:events";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const spawnMock = vi.hoisted(() => vi.fn());
vi.mock("node:child_process", () => ({ spawn: spawnMock }));

import { StandardProcessDriver } from "./standard-process.driver.js";

describe("standalone driver container environment", () => {
  let tempDirectory: string;
  let child: EventEmitter & { stdout: EventEmitter; stderr: EventEmitter };

  beforeEach(() => {
    tempDirectory = mkdtempSync(join(tmpdir(), "standard-driver-test-"));
    child = Object.assign(new EventEmitter(), { stdout: new EventEmitter(), stderr: new EventEmitter() });
    spawnMock.mockReturnValue(child);
  });

  afterEach(() => {
    rmSync(tempDirectory, { recursive: true, force: true });
    vi.clearAllMocks();
  });

  it("preserves the image HOME and supplies a fallback when it has none", async () => {
    const hostWorkingDir = join(tempDirectory, "worker", "wd");
    const handle = new StandardProcessDriver().execute({
      jobId: "42",
      step: { id: "build" },
      command: "printf '%s' \"$HOME\"",
      workingDir: hostWorkingDir,
      logsDir: join(tempDirectory, "logs"),
      env: { WORKING_DIR: hostWorkingDir, CI: "true" },
      image: "node:22",
    } as any);

    const [command, args, options] = spawnMock.mock.calls[0] as [string, string[], { env: NodeJS.ProcessEnv }];
    const imageIndex = args.indexOf("node:22");
    expect(command).toBe("docker");
    expect(options.env.HOME).toBeTruthy();
    expect(args.slice(0, imageIndex)).not.toContain("HOME");
    expect(args.slice(imageIndex)).toContain(
      'if [ -z "${HOME:-}" ]; then HOME=/root; fi; export HOME; exec /bin/sh -e -c "$1"',
    );

    child.emit("close", 0, null);
    await handle.done;
  });
});
