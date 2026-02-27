import test from "node:test";
import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import path from "node:path";
import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import os from "node:os";

const cliPath = path.resolve("src/index.ts");

test("prints help", () => {
  const result = spawnSync(process.execPath, ["--import", "tsx", cliPath, "--help"], {
    cwd: path.resolve("."),
    encoding: "utf8"
  });

  assert.equal(result.status, 0);
  assert.match(result.stdout, /daemonized webhook runner/);
});

test("starts daemon and spawns a process from a webhook", async () => {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "on-cli-test-"));
  const markerPath = path.join(tempDir, "marker.txt");

  const daemon = spawn(process.execPath, ["--import", "tsx", cliPath, "--port", "4011"], {
    cwd: path.resolve("."),
    stdio: ["ignore", "pipe", "pipe"]
  });

  await new Promise<void>((resolve, reject) => {
    const timeout = setTimeout(() => {
      reject(new Error("daemon did not start in time"));
    }, 4000);

    daemon.stdout.on("data", (buffer) => {
      const text = buffer.toString("utf8");
      if (text.includes("on daemon listening")) {
        clearTimeout(timeout);
        resolve();
      }
    });

    daemon.once("exit", (code) => {
      clearTimeout(timeout);
      reject(new Error(`daemon exited unexpectedly with code ${code}`));
    });
  });

  const payload = {
    command: process.execPath,
    args: ["-e", `require('node:fs').writeFileSync('${markerPath.replaceAll("\\", "\\\\")}', 'ok')`]
  };

  const response = await fetch("http://127.0.0.1:4011", {
    method: "POST",
    headers: {
      "content-type": "application/json"
    },
    body: JSON.stringify(payload)
  });

  assert.equal(response.status, 202);

  await new Promise((resolve) => setTimeout(resolve, 500));
  const markerStats = await stat(markerPath);
  assert.ok(markerStats.isFile());

  daemon.kill("SIGTERM");
  await new Promise((resolve) => daemon.once("exit", resolve));

  const markerContents = await readFile(markerPath, "utf8");
  assert.equal(markerContents, "ok");

  await rm(tempDir, { recursive: true, force: true });
});
