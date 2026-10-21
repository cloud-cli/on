import { beforeEach, describe, expect, it, vi } from "vitest";

const database = vi.hoisted(() => ({
  all: vi.fn(),
  get: vi.fn(),
  run: vi.fn(),
  exec: vi.fn(),
}));

vi.mock("./db-client.js", () => ({ default: database }));

import { OidcUserRepository } from "./oidc-user-repository.js";

describe("OIDC user management repository", () => {
  beforeEach(() => vi.resetAllMocks());

  it("returns only roster fields and normalizes roles", async () => {
    database.all.mockResolvedValue([
      { subject: "subject-1", name: "Ada", email: "ada@example.test", role: "admin" },
      { subject: "subject-2", name: null, email: null, role: "unknown" },
    ]);

    await expect(new OidcUserRepository().list()).resolves.toEqual([
      { id: "subject-1", name: "Ada", email: "ada@example.test", role: "admin" },
      { id: "subject-2", name: undefined, email: undefined, role: "user" },
    ]);
  });

  it("marks Agent subjects separately and excludes them from the human user roster", async () => {
    const repository = new OidcUserRepository();
    await repository.upsert({ id: "agent_build-runner", role: "agent" });
    expect(database.run.mock.calls[0][0]).toContain("preferred_username, kind)");
    expect(database.run.mock.calls[0][1].at(-1)).toBe("agent");

    database.all.mockResolvedValue([]);
    await repository.list();
    expect(database.all.mock.calls.at(-1)?.[0]).toContain("subject NOT GLOB 'agent_*'");
  });

  it("does not update a nonexistent user", async () => {
    database.get.mockResolvedValue(null);

    await expect(new OidcUserRepository().setRole("missing", "admin")).resolves.toBe("not-found");
    expect(database.run).not.toHaveBeenCalled();
  });

  it("updates a role with the last-admin guard in the same SQL statement", async () => {
    database.get.mockResolvedValue({ role: "admin" });
    database.run.mockResolvedValue({ changes: 1 });

    await expect(new OidcUserRepository().setRole("subject-1", "user")).resolves.toBe("updated");
    const [statement, parameters] = database.run.mock.calls[0];
    expect(statement).toContain("SELECT COUNT(*) FROM oidc_users WHERE role = 'admin'");
    expect(parameters).toEqual(["user", "subject-1", "user"]);
  });

  it("reports a final administrator demotion without changing the row", async () => {
    database.get.mockResolvedValueOnce({ role: "admin" }).mockResolvedValueOnce({ subject: "subject-1" });
    database.run.mockResolvedValue({ changes: 0 });

    await expect(new OidcUserRepository().setRole("subject-1", "user")).resolves.toBe("last-admin");
  });
});
