import { test, expect, afterAll } from "vitest";
import { ChildProcess, spawn, spawnSync } from "node:child_process";
import path from "node:path";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import { AddressInfo } from "node:net";
import net from "node:net";
import { existsSync } from "node:fs";

const processes = new Set<ChildProcess>();
const cliPath = path.resolve("./src/cli.ts");
const getPort = () =>
  new Promise<number>((resolve, reject) => {
    const server = net.createServer();
    server.listen(0, () => {
      const address = server.address() as AddressInfo;
      const port = address.port;
      server.close(() => resolve(port));
    });
    server.on("error", (err: Error) => reject(err));
  });

const startDaemon = async (options: { configPath?: string }) => {
  const port = await getPort();

  function sendEvent(event: any) {
    return fetch(`http://127.0.0.1:${port}`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
      },
      body: JSON.stringify(event),
    });
  }

  function stop() {
    return new Promise((resolve) => {
      server.on("exit", resolve);
      server.kill();
    });
  }

  const args = [
    "--import",
    "tsx",
    cliPath,
    "--port",
    String(port),
    "--host",
    "127.0.0.1",
  ];

  if (options.configPath) {
    args.push("--config", options.configPath);
  }

  const server = spawn(process.execPath, args);

  processes.add(server);
  server.once("exit", () => processes.delete(server));
  server.stdout?.pipe(process.stdout);
  server.stderr?.pipe(process.stderr);

  await new Promise((resolve) => setTimeout(resolve, 1000));

  return { sendEvent, stop };
};

afterAll(() => {
  processes.forEach((proc) => proc.kill());
});

const getTempDir = () => mkdtemp(path.join(os.tmpdir(), "on-workflow-test-"));
const cleanUp = (tempDir: string) =>
  rm(tempDir, { recursive: true, force: true });

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

test(
  "executes workflow with mappings, secrets, env interpolation, defaults and dispatch",
  { timeout: 30000 },
  async () => {
    const tempDir = await getTempDir();
    const secretsPath = path.join(tempDir, ".env");
    const resultPath = path.join(tempDir, "result.txt");
    const dispatchedMarkerPath = path.join(tempDir, "dispatched.txt");
    const configPath = path.join(tempDir, "config.json");
    const triggerPath = path.join(tempDir, "trigger.json");

    await writeFile(secretsPath, "A_SECRET=top-secret\n");

    const config = {
      on: {
        published: {
          runner: "docker",
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
            "echo ${inputs}",
            "echo '{\"followup\":{}}' > /tmp/trigger.json",
            "echo ${env.A_SECRET} >> /tmp/result.txt",
            "echo ${inputs.url} >> /tmp/result.txt",
            "echo ${workflow.defaults.image} >> /tmp/result.txt",
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

    const { sendEvent, stop } = await startDaemon({ configPath });
    const response = await sendEvent(event);

    await stop();

    expect(response.status).toBe(202);

    expect(existsSync(resultPath)).toBe(true);
    const resultContents = (await readFile(resultPath, "utf8")) as string;
    expect(resultContents).toContain("top-secret");
    expect(resultContents).toContain("registry/image:v1");
    expect(resultContents).toContain("node:latest");

    const dispatchedMarker = (
      (await readFile(dispatchedMarkerPath, "utf8")) as string
    ).trim();
    expect(dispatchedMarker).toBe("OK");

    await cleanUp(tempDir);
  },
);

test("stop workflow if one step fails", async () => {
  const tempDir = await getTempDir();
  const resultPath = path.join(tempDir, "result.txt");
  const configPath = path.join(tempDir, "config.json");

  const config = {
    on: {
      test: {
        // omitted runner to pick up the default "docker"
        steps: [
          "echo first > /tmp/result.txt",
          "cat /not/existing",
          "echo second > /tmp/result.txt",
        ],
        defaults: {
          image: "node:latest",
          volumes: { [tempDir]: "/tmp" },
        },
      },
    },
  };

  await writeFile(configPath, JSON.stringify(config, null, 2));

  const event = { test: {} };
  const { sendEvent, stop } = await startDaemon({ configPath });
  const response = await sendEvent(event);

  await stop();

  expect(response.status).toBe(202);

  expect(existsSync(resultPath)).toBe(true);
  const resultContents = await readFile(resultPath, "utf8");
  expect(resultContents).toContain("first");
  expect(resultContents).not.toContain("second");

  await cleanUp(tempDir);
});

test("run workflow on shell", async () => {
  const tempDir = await getTempDir();
  const resultPath = path.join(tempDir, "result.txt");
  const configPath = path.join(tempDir, "config.json");

  const config = {
    on: {
      test: {
        runner: "shell",
        steps: [
          {
            run: "echo works > result.txt",
            workingDir: tempDir,
          },
        ],
      },
    },
  };

  await writeFile(configPath, JSON.stringify(config, null, 2));

  const event = { test: {} };
  const { sendEvent, stop } = await startDaemon({ configPath });
  const response = await sendEvent(event);

  await stop();

  expect(response.status).toBe(202);
  expect(existsSync(resultPath)).toBe(true);
  const resultContents = await readFile(resultPath, "utf8");
  expect(resultContents).toContain("works");

  await cleanUp(tempDir);
});

test("skip workflow based on conditions", async () => {
  const tempDir = await getTempDir();
  const resultPath = path.join(tempDir, "result.txt");
  const configPath = path.join(tempDir, "config.json");

  const config = {
    on: {
      test: {
        runner: "shell",
        if: [
          "${inputs.value} === 123 ",
        ],
        steps: [
          {
            run: "echo works > result.txt",
            workingDir: tempDir,
          },
        ],
      },
    },
  };

  await writeFile(configPath, JSON.stringify(config, null, 2));

  const event = { test: { value: 456 } };
  const { sendEvent, stop } = await startDaemon({ configPath });
  const response = await sendEvent(event);

  await stop();

  expect(response.status).toBe(202);
  expect(existsSync(resultPath)).toBe(false);

  await cleanUp(tempDir);
});


test("returns 202 for payloads that do not trigger any workflow", async () => {
  const { sendEvent, stop } = await startDaemon({ configPath: undefined });
  const response = await sendEvent({ wrong: true });

  await stop();

  expect(response.status).toBe(202);
});

test("converts objects to JSON when interpolating", async () => {
  const tempDir = await getTempDir();
  const resultPath = path.join(tempDir, "result.txt");
  const configPath = path.join(tempDir, "config.json");

  const config = {
    on: {
      test: {
        steps: ["echo ${inputs} > /tmp/result.txt"],
        defaults: {
          image: "node:latest",
          volumes: { [tempDir]: "/tmp" },
        },
      },
    },
  };

  await writeFile(configPath, JSON.stringify(config, null, 2));

  const event = { test: { a: 1, b: [1, 2], c: { nested: true } } };
  const { sendEvent, stop } = await startDaemon({ configPath });
  const response = await sendEvent(event);

  await stop();

  expect(response.status).toBe(202);

  expect(existsSync(resultPath)).toBe(true);
  const resultContents = (await readFile(resultPath, "utf8")).trim();
  expect(resultContents).toBe(JSON.stringify(event.test));

  await cleanUp(tempDir);
});
