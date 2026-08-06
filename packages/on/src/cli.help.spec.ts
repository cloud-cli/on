import { spawnSync } from "node:child_process";
import path from "node:path";
import { expect, test } from "vitest";

import { cliPath } from "../test/cli-test-helpers.js";

test("prints help", () => {
  const cwd = path.resolve(".");
  const args = ["--import", "tsx", cliPath, "--help"];

  const result = spawnSync(process.execPath, args, {
    cwd,
    encoding: "utf8",
  });

  expect(result.status).toBe(0);
  expect(result.stdout).toMatch(/daemonized webhook runner/);
});
