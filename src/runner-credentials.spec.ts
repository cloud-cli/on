import { chmod, mkdtemp, readFile, rm, stat, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { enrollRunner, readRunnerCredential, writeRunnerCredential } from "./runner-credentials.js";

let directory: string | undefined;
afterEach(async () => {
  if (directory) await rm(directory, { recursive: true, force: true });
  directory = undefined;
});

describe("runner credential bootstrap", () => {
  it("enrolls without sending a bearer credential and saves token with private mode", async () => {
    directory = await mkdtemp(join(tmpdir(), "runner-credential-"));
    const fetcher = vi.fn(async () => new Response(JSON.stringify({ runnerId: "r1", credential: "onr_secret" })));
    const issued = await enrollRunner(
      "https://runner.example",
      "one-time-code",
      "build-1",
      "node",
      fetcher as typeof fetch,
    );
    const [url, init] = fetcher.mock.calls[0];
    expect(url).toEqual(new URL("https://runner.example/api/v1/runners/enroll"));
    expect(new Headers(init?.headers).has("authorization")).toBe(false);
    expect(JSON.parse(String(init?.body))).toEqual({ code: "one-time-code", name: "build-1", runtime: "node" });

    const path = join(directory, "nested", "credential");
    await writeRunnerCredential(path, issued.credential);
    expect(await readRunnerCredential(path)).toBe("onr_secret");
    expect((await stat(path)).mode & 0o777).toBe(0o600);
    expect(await readFile(path, "utf8")).toBe("onr_secret\n");
  });

  it("rejects unsafe transport and malformed enrollment responses", async () => {
    await expect(enrollRunner("http://external.example", "code", "runner", "node")).rejects.toThrow("HTTPS");
    await expect(
      enrollRunner(
        "https://runner.example",
        "code",
        "runner",
        "node",
        vi.fn(async () => new Response("{}")) as typeof fetch,
      ),
    ).rejects.toThrow("invalid enrollment response");
  });

  it("rejects credentials with broad permissions and symlinked credential paths", async () => {
    directory = await mkdtemp(join(tmpdir(), "runner-credential-security-"));
    const path = join(directory, "credential");
    await writeFile(path, "secret\n", { mode: 0o644 });
    await chmod(path, 0o644);
    await expect(readRunnerCredential(path)).rejects.toThrow("private regular file");

    const target = join(directory, "target");
    await writeFile(target, "secret\n", { mode: 0o600 });
    const link = join(directory, "link");
    await symlink(target, link);
    await expect(readRunnerCredential(link)).rejects.toMatchObject({ code: "ELOOP" });
  });
});
