import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import path from "node:path";

const cliPath = path.resolve("src/index.ts");

test("prints help", () => {
  const result = spawnSync(process.execPath, ["--import", "tsx", cliPath, "--help"], {
    cwd: path.resolve("."),
    encoding: "utf8"
  });

  assert.equal(result.status, 0);
  assert.match(result.stdout, /CLI entry point/);
});
