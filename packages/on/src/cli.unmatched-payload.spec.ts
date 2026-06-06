import { expect, test } from "vitest";

import { startDaemon } from "../test/cli-test-helpers.js";

test("returns 202 for payloads that do not trigger any workflow", async () => {
  const { sendEvent, stop } = await startDaemon({ configPath: undefined });
  const response = await sendEvent({ wrong: true });

  await stop();

  expect(response.status).toBe(202);
});
