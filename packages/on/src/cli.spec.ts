import { test, expect } from "vitest";
import { ChildProcess, spawn, spawnSync } from "node:child_process";
import path from "node:path";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import { AddressInfo } from "node:net";

const cliPath = path.resolve("./src/index.ts");
const getPort = () =>
  new Promise<number>((resolve, reject) => {
    const server = require("node:net").createServer();
    server.listen(0, () => {
      const address = server.address() as AddressInfo;
      const port = address.port;
      server.close(() => resolve(port));
    });
    server.on("error", (err: Error) => reject(err));
  });

const startDaemon = async (options: {
  port: number;
  host: string;
  configPath?: string;
}) => {
  const args = [
    "--import",
    "tsx",
    cliPath,
    "--port",
    options.port.toString(),
    "--host",
    options.host,
  ];

  if (options.configPath) {
    args.push("--config", options.configPath);
  }

  const daemon = spawn(process.execPath, args, {
    stdio: "inherit",
  });

  await new Promise((resolve) => setTimeout(resolve, 1000));

  return daemon;
};

async function killServer(server: ChildProcess) {
  return new Promise((resolve) => {
    server.on("exit", (code) => resolve(code));
    server.kill();
  });
}

function nodeStep(source: string): string {
  return `${process.execPath} -e ${JSON.stringify(source)}`;
}

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
            image: "inputs.package.package_version.package_url",
          },
          env: {
            A_SECRET: "${secrets.A_SECRET}",
            A_VALUE: "${inputs.image}",
          },
          defaults: {
            image: "node:20",
            volumes: { ".": "/home" },
            args: { net: "host" },
          },
          steps: [
            nodeStep(
              `const fs = require('node:fs'); fs.writeFileSync(${JSON.stringify(
                resultPath,
              )}, JSON.stringify({ secret: process.env.A_SECRET, value: process.env.A_VALUE, image: process.env.ON_DEFAULT_IMAGE, volumes: process.env.ON_DEFAULT_VOLUMES, args: process.env.ON_DEFAULT_ARGS })); fs.writeFileSync(${JSON.stringify(
                dispatchPayloadPath,
              )}, JSON.stringify({ source: 'internal', event: 'followup' }));`,
            ),
          ],
          triggers: [dispatchPayloadPath],
        },
      },
      internal: {
        followup: {
          steps: [
            nodeStep(
              `require('node:fs').writeFileSync(${JSON.stringify(dispatchedMarkerPath)}, 'ok');`,
            ),
          ],
        },
      },
    },
  };

  await writeFile(configPath, JSON.stringify(config, null, 2));

  const port = await getPort();
  const server = await startDaemon({ port, host: "127.0.0.1", configPath });
  const response = await fetch(`http://127.0.0.1:${port}`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
    },
    body: JSON.stringify({
      source: "github",
      event: "published",
      package: {
        package_version: {
          package_url: "registry/image:v1",
        },
      },
    }),
  });

  expect(response.status).toBe(202);

  const resultContents = JSON.parse(
    await readFile(resultPath, "utf8"),
  ) as Record<string, string>;
  expect(resultContents.secret).toBe("top-secret");
  expect(resultContents.value).toBe("registry/image:v1");
  expect(resultContents.image).toBe("node:20");
  expect(resultContents.volumes).toBe(JSON.stringify({ ".": "/home" }));
  expect(resultContents.args).toBe(JSON.stringify({ net: "host" }));

  await killServer(server);
  const dispatchedMarker = await readFile(dispatchedMarkerPath, "utf8");
  expect(dispatchedMarker).toBe("ok");
  await rm(tempDir, { recursive: true, force: true });
});

test("returns 400 for payloads without source and event", async () => {
  const port = await getPort();
  const server = await startDaemon({
    port,
    host: "127.0.0.1",
    configPath: undefined,
  });

  const response = await fetch(`http://127.0.0.1:${port}`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
    },
    body: JSON.stringify({ wrong: true }),
  });

  await killServer(server);
  expect(response.status).toBe(400);
  const body = (await response.json()) as { error: string };
  expect(body.error).toMatch(/source/);
});
