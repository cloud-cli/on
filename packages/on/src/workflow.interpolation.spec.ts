import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { expect, test } from "vitest";

import {
  cleanUp,
  existsSync,
  getTempDir,
  startDaemon,
} from "../test/cli-test-helpers.js";

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
