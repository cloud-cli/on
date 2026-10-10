import assert from "node:assert/strict";
import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { spawnSync } from "node:child_process";

async function files(directory) {
  const entries = await readdir(directory, { withFileTypes: true });
  return (
    await Promise.all(
      entries.map(async (entry) => {
        const path = join(directory, entry.name);
        return entry.isDirectory() ? files(path) : [path];
      }),
    )
  ).flat();
}

const outputFiles = (await files("dist")).filter((path) => path.endsWith(".js"));
assert.ok(
  outputFiles.some((path) => path.endsWith("/worker.js")),
  "worker entry was not built",
);
for (const path of outputFiles) {
  const source = await readFile(path, "utf8");
  assert.doesNotMatch(
    source,
    /(?:db-client|src\/server\.js|src\/scheduler\.js|src\/workflows\.js)/,
    `DB/coordinator module found in ${path}`,
  );
}

const result = spawnSync(process.execPath, ["dist/worker.js"], {
  encoding: "utf8",
  env: {
    PATH: process.env.PATH,
    HOME: process.env.HOME,
    RUNNER_SERVER_URL: "http://127.0.0.1:11235",
  },
});
assert.notEqual(result.status, 0, "worker should require enrollment or an existing runner credential");
assert.match(result.stderr, /RUNNER_CREDENTIAL|RUNNER_ENROLLMENT_CODE/);
assert.doesNotMatch(result.stderr, /DATABASE_URL is required/);
console.log("Worker artifact is DB-free at startup and correctly requires runner credentials.");
