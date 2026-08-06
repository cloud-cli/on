import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { expect, test } from "vitest";

import {
  cleanUp,
  existsSync,
  getTempDir,
  startDaemon,
} from "../test/cli-test-helpers.js";

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
