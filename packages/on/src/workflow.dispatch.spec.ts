import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { expect, test } from "vitest";

import {
  cleanUp,
  existsSync,
  getTempDir,
  startDaemon,
} from "../test/cli-test-helpers.js";

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
    const resultContents = await readFile(resultPath, "utf8");
    expect(resultContents).toContain("top-secret");
    expect(resultContents).toContain("registry/image:v1");
    expect(resultContents).toContain("node:latest");

    const dispatchedMarker = (
      await readFile(dispatchedMarkerPath, "utf8")
    ).trim();
    expect(dispatchedMarker).toBe("OK");

    await cleanUp(tempDir);
  },
);
