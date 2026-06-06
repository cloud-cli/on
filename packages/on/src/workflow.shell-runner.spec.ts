import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { expect, test } from "vitest";

import {
  cleanUp,
  existsSync,
  getTempDir,
  startDaemon,
} from "../test/cli-test-helpers.js";

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
