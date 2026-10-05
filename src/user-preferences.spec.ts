import { beforeEach, describe, expect, it, vi } from "vitest";

const database = vi.hoisted(() => ({ get: vi.fn(), run: vi.fn(), all: vi.fn(), exec: vi.fn() }));
vi.mock("./db-client.js", () => ({ default: database }));

import { UserPreferencesRepository } from "./user-preferences.js";

describe("per-user UI preferences", () => {
  beforeEach(() => vi.resetAllMocks());

  it("returns null when a user has not chosen a timezone", async () => {
    database.get.mockResolvedValue(null);
    await expect(new UserPreferencesRepository().getTimezone("user-1")).resolves.toBeNull();
  });

  it("stores and reads a timezone scoped to the user subject", async () => {
    database.get.mockResolvedValue({ value: "Europe/Paris" });
    const repository = new UserPreferencesRepository();
    await repository.setTimezone("user-1", "Europe/Paris");
    await expect(repository.getTimezone("user-1")).resolves.toBe("Europe/Paris");
    expect(database.run).toHaveBeenCalledWith(expect.stringContaining("ON CONFLICT(user_id, preference)"), [
      "user-1",
      "Europe/Paris",
    ]);
  });
});
