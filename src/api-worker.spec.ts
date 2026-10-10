import { afterEach, describe, expect, it, vi } from "vitest";

describe("API-only worker module boundary", () => {
  afterEach(() => vi.unstubAllEnvs());

  it("can be imported without database credentials", async () => {
    vi.stubEnv("DATABASE_URL", "");
    vi.resetModules();
    await expect(import("./api-worker.js")).resolves.toHaveProperty("startApiWorkers");
  });
});
