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

test("executes workflow with mappings, secrets, env interpolation, defaults and dispatch", { timeout: 30000 }, async () => {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "on-workflow-test-"));
  const secretsPath = path.join(tempDir, ".env");
  const resultPath = path.join(tempDir, "result.txt");
  const dispatchedMarkerPath = path.join(tempDir, "dispatched.txt");
  const configPath = path.join(tempDir, "config.json");
  const triggerPath = path.join(tempDir, "trigger.json");

  await writeFile(secretsPath, "A_SECRET=top-secret\n");

  const config = {
    on: {
      published: {
        secrets: [secretsPath],
        mappings: {
          url: "inputs.package.package_version.package_url",
        },
        env: {
          A_SECRET: "${secrets.A_SECRET}",
          A_VALUE: "${inputs.image}",
        },
        defaults: {
          image: "node:latest",
          volumes: { ".": "/home", [tempDir]: "/tmp" },
          args: [{ name: "published" }],
        },
        steps: [
          "pwd",
          "echo '{\"followup\":{}}' > /tmp/trigger.json",
          "echo ${env.A_SECRET} >> /tmp/result.txt",
          "echo ${inputs.url} >> /tmp/result.txt",
          "echo ${step.image} >> /tmp/result.txt",
        ],
        triggers: [triggerPath],
      },
      followup: {
        steps: [
          {
            run: "echo OK > /tmp/dispatched.txt",
            volumes: { [tempDir]: "/tmp" },
            image: "node:latest",
          },
        ],
      },
    },
  };

  await writeFile(configPath, JSON.stringify(config, null, 2));

  const event = {
    published: {
      package: {
        package_version: {
          package_url: "registry/image:v1",
        },
      },
    },
  };
  const port = await getPort();
  const server = await startDaemon({ port, host: "127.0.0.1", configPath });
  const response = await fetch(`http://127.0.0.1:${port}`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
    },
    body: JSON.stringify(event),
  });

  await killServer(server);

  expect(response.status).toBe(202);

  const resultContents = (await readFile(resultPath, "utf8")) as string;
  expect(resultContents).toContain("top-secret");
  expect(resultContents).toContain("registry/image:v1");
  expect(resultContents).toContain("node:latest");

  const dispatchedMarker = (
    (await readFile(dispatchedMarkerPath, "utf8")) as string
  ).trim();
  expect(dispatchedMarker).toBe("OK");
  await rm(tempDir, { recursive: true, force: true });
});

test("returns 202 for payloads that do not trigger any workflow", async () => {
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
  expect(response.status).toBe(202);
});
