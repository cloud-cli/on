import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import path from "node:path";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import { startDaemon } from "../src/index.js";

const cliPath = path.resolve("src/index.ts");

function nodeStep(source: string): string {
  return `${process.execPath} -e ${JSON.stringify(source)}`;
}

test("prints help", () => {
  const result = spawnSync(process.execPath, ["--import", "tsx", cliPath, "--help"], {
    cwd: path.resolve("."),
    encoding: "utf8"
  });

  assert.equal(result.status, 0);
  assert.match(result.stdout, /daemonized webhook runner/);
});

test("executes workflow with mappings, secrets, env interpolation, defaults and dispatch", async () => {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "on-workflow-test-"));
  const secretsPath = path.join(tempDir, ".env");
  const resultPath = path.join(tempDir, "result.json");
  const dispatchPayloadPath = path.join(tempDir, "dispatch.json");
  const dispatchedMarkerPath = path.join(tempDir, "dispatched.txt");
  const configPath = path.join(tempDir, "config.json");

  await writeFile(secretsPath, "A_SECRET=top-secret\n");

  const config = {
    on: {
      github: {
        published: {
          secrets: [secretsPath],
          mappings: {
            image: "inputs.package.package_version.package_url"
          },
          env: {
            A_SECRET: "${secrets.A_SECRET}",
            A_VALUE: "${inputs.image}"
          },
          defaults: {
            image: "node:20",
            volumes: { ".": "/home" },
            args: { net: "host" }
          },
          steps: [
            nodeStep(
              `const fs = require('node:fs'); fs.writeFileSync(${JSON.stringify(
                resultPath
              )}, JSON.stringify({ secret: process.env.A_SECRET, value: process.env.A_VALUE, image: process.env.ON_DEFAULT_IMAGE, volumes: process.env.ON_DEFAULT_VOLUMES, args: process.env.ON_DEFAULT_ARGS })); fs.writeFileSync(${JSON.stringify(
                dispatchPayloadPath
              )}, JSON.stringify({ source: 'internal', event: 'followup' }));`
            )
          ],
          dispatch: [dispatchPayloadPath]
        }
      },
      internal: {
        followup: {
          steps: [
            nodeStep(`require('node:fs').writeFileSync(${JSON.stringify(dispatchedMarkerPath)}, 'ok');`)
          ]
        }
      }
    }
  };

  await writeFile(configPath, JSON.stringify(config, null, 2));

  const server = await startDaemon({ port: 0, host: "127.0.0.1", configPath });
  const address = server.address();
  assert.ok(address && typeof address === "object");

  const response = await fetch(`http://127.0.0.1:${address.port}`, {
    method: "POST",
    headers: {
      "content-type": "application/json"
    },
    body: JSON.stringify({
      source: "github",
      event: "published",
      package: {
        package_version: {
          package_url: "registry/image:v1"
        }
      }
    })
  });

  assert.equal(response.status, 202);

  const resultContents = JSON.parse(await readFile(resultPath, "utf8")) as Record<string, string>;
  assert.equal(resultContents.secret, "top-secret");
  assert.equal(resultContents.value, "registry/image:v1");
  assert.equal(resultContents.image, "node:20");
  assert.equal(resultContents.volumes, JSON.stringify({ ".": "/home" }));
  assert.equal(resultContents.args, JSON.stringify({ net: "host" }));

  const dispatchedMarker = await readFile(dispatchedMarkerPath, "utf8");
  assert.equal(dispatchedMarker, "ok");

  await new Promise<void>((resolve, reject) => server.close((error: Error | undefined) => (error ? reject(error) : resolve())));
  await rm(tempDir, { recursive: true, force: true });
});

test("returns 400 for payloads without source and event", async () => {
  const server = await startDaemon({ port: 0, host: "127.0.0.1", configPath: undefined });
  const address = server.address();
  assert.ok(address && typeof address === "object");

  const response = await fetch(`http://127.0.0.1:${address.port}`, {
    method: "POST",
    headers: {
      "content-type": "application/json"
    },
    body: JSON.stringify({ wrong: true })
  });

  assert.equal(response.status, 400);
  const body = (await response.json()) as { error: string };
  assert.match(body.error, /source/);

  await new Promise<void>((resolve, reject) => server.close((error: Error | undefined) => (error ? reject(error) : resolve())));
});
