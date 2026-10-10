import { mkdir, open } from "node:fs/promises";
import { constants } from "node:fs";
import { dirname } from "node:path";
import { randomBytes } from "node:crypto";
import { rename, unlink } from "node:fs/promises";

/** Credentials are plaintext bearer tokens; protect this file as a secret. */
export async function readRunnerCredential(path: string): Promise<string | undefined> {
  let file: Awaited<ReturnType<typeof open>> | undefined;
  try {
    file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
    const metadata = await file.stat();
    if (!metadata.isFile() || (metadata.mode & 0o077) !== 0) {
      throw new Error("Runner credential file must be a private regular file (mode 0600)");
    }
    if (typeof process.getuid === "function" && metadata.uid !== process.getuid()) {
      throw new Error("Runner credential file must be owned by the runner user");
    }
    const credential = (await file.readFile("utf8")).trim();
    return credential || undefined;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw error;
  } finally {
    await file?.close();
  }
}

/** Persist only newly issued credentials, with owner-only permissions. */
export async function writeRunnerCredential(path: string, credential: string): Promise<void> {
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  const temporaryPath = `${path}.${process.pid}.${randomBytes(8).toString("hex")}.tmp`;
  const file = await open(
    temporaryPath,
    constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW,
    0o600,
  );
  try {
    await file.chmod(0o600);
    await file.writeFile(`${credential}\n`, { encoding: "utf8" });
    await file.sync();
  } finally {
    await file.close();
  }
  try {
    await rename(temporaryPath, path);
  } catch (error) {
    await unlink(temporaryPath).catch(() => undefined);
    throw error;
  }
}

export async function enrollRunner(
  serverUrl: string,
  code: string,
  name: string,
  runtime: string,
  fetcher: typeof fetch = fetch,
): Promise<{ runnerId: string; credential: string }> {
  const base = new URL(serverUrl);
  if (
    base.protocol !== "https:" &&
    !(base.protocol === "http:" && ["localhost", "127.0.0.1", "::1"].includes(base.hostname))
  ) {
    throw new Error("Runner coordinator URLs must use HTTPS outside loopback");
  }
  const response = await fetcher(new URL("/api/v1/runners/enroll", base), {
    method: "POST",
    headers: { "Content-Type": "application/json", Accept: "application/json" },
    body: JSON.stringify({ code, name, runtime }),
  });
  if (!response.ok) throw new Error(`Runner enrollment failed (${response.status})`);
  const result = (await response.json()) as { runnerId?: unknown; credential?: unknown };
  if (typeof result.runnerId !== "string" || typeof result.credential !== "string" || !result.credential) {
    throw new Error("Coordinator returned an invalid enrollment response");
  }
  return { runnerId: result.runnerId, credential: result.credential };
}
