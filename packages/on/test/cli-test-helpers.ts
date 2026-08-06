import { ChildProcess, spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import net, { AddressInfo } from "node:net";
import os from "node:os";
import path from "node:path";
import { afterAll } from "vitest";

const processes = new Set<ChildProcess>();
const cliPath = path.resolve("./src/cli.ts");

const getPort = () =>
  new Promise<number>((resolve, reject) => {
    const server = net.createServer();
    server.listen(0, "127.0.0.1", () => {
      const address = server.address() as AddressInfo;
      const port = address.port;
      server.close(() => resolve(port));
    });
    server.on("error", (err: Error) => reject(err));
  });

export const startDaemon = async (options: { configPath?: string }) => {
  const port = await getPort();
  let exited = false;
  let exitStatus = "";

  function sendEvent(event: unknown) {
    return fetch(`http://127.0.0.1:${port}`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
      },
      body: JSON.stringify(event),
    });
  }

  function stop() {
    if (exited) {
      return Promise.resolve();
    }

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
  server.once("exit", (code, signal) => {
    exited = true;
    exitStatus = `code ${code ?? "null"}, signal ${signal ?? "null"}`;
    processes.delete(server);
  });
  server.stdout?.pipe(process.stdout);
  server.stderr?.pipe(process.stderr);

  await waitForDaemon(port, () => ({ exited, exitStatus }));

  return { sendEvent, stop };
};

const waitForDaemon = async (
  port: number,
  getStatus: () => { exited: boolean; exitStatus: string },
) => {
  const deadline = Date.now() + 5000;
  let lastError: unknown;

  while (Date.now() < deadline) {
    const status = getStatus();

    if (status.exited) {
      throw new Error(
        `Daemon exited before startup completed: ${status.exitStatus}`,
      );
    }

    try {
      const response = await fetch(`http://127.0.0.1:${port}/health`);

      if (response.ok) {
        return;
      }
    } catch (error) {
      lastError = error;
    }

    await new Promise((resolve) => setTimeout(resolve, 100));
  }

  throw new Error(`Daemon did not start in time: ${String(lastError)}`);
};

afterAll(() => {
  processes.forEach((proc) => proc.kill());
});

export const getTempDir = () =>
  mkdtemp(path.join(os.tmpdir(), "on-workflow-test-"));

export const cleanUp = (tempDir: string) =>
  rm(tempDir, { recursive: true, force: true });

export { cliPath, existsSync };
