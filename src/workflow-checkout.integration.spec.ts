import { execFileSync, spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

describe("documented workflow checkout", () => {
  let tempDirectory: string | undefined;

  afterEach(() => {
    if (tempDirectory) {
      rmSync(tempDirectory, { recursive: true, force: true });
      tempDirectory = undefined;
    }
  });

  it("checks out the requested commit after its branch has moved", () => {
    const workflowSyntax = readFileSync(new URL("../docs/workflow-syntax.md", import.meta.url), "utf8");
    expect(workflowSyntax).toContain('git clone --depth 1 "$clone_url" .');
    expect(workflowSyntax).toContain('git fetch --depth 1 origin "$commit_sha"');
    expect(workflowSyntax).toContain('git checkout --detach "$commit_sha"');
    tempDirectory = mkdtempSync(join(tmpdir(), "workflow-checkout-"));
    const repository = join(tempDirectory, "repository");
    const checkout = join(tempDirectory, "checkout");
    const git = (cwd: string, ...args: string[]) =>
      execFileSync("git", args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();

    execFileSync("git", ["init", "--quiet", repository]);
    git(repository, "config", "user.email", "test@example.invalid");
    git(repository, "config", "user.name", "Workflow checkout test");
    writeFileSync(join(repository, "revision.txt"), "requested revision\n");
    git(repository, "add", "revision.txt");
    git(repository, "commit", "--quiet", "-m", "requested revision");
    const requestedCommit = git(repository, "rev-parse", "HEAD");

    writeFileSync(join(repository, "revision.txt"), "moved branch revision\n");
    git(repository, "commit", "--quiet", "-am", "move branch");
    const movedBranchCommit = git(repository, "rev-parse", "HEAD");
    expect(movedBranchCommit).not.toBe(requestedCommit);

    mkdirSync(checkout);
    execFileSync(
      "sh",
      [
        "-e",
        "-c",
        'git clone --depth 1 "$clone_url" .\ngit fetch --depth 1 origin "$commit_sha"\ngit checkout --detach "$commit_sha"',
      ],
      {
        cwd: checkout,
        env: { ...process.env, clone_url: `file://${repository}`, commit_sha: requestedCommit },
        stdio: "pipe",
      },
    );

    expect(git(checkout, "rev-parse", "HEAD")).toBe(requestedCommit);
    expect(readFileSync(join(checkout, "revision.txt"), "utf8")).toBe("requested revision\n");
  });

  it("does not substitute a lagging mirror's branch head when the requested commit is absent", () => {
    const workflowSyntax = readFileSync(new URL("../docs/workflow-syntax.md", import.meta.url), "utf8");
    expect(workflowSyntax).toContain('git fetch --depth 1 origin "$commit_sha"');
    expect(workflowSyntax).toContain('git checkout --detach "$commit_sha"');
    tempDirectory = mkdtempSync(join(tmpdir(), "workflow-lagging-mirror-"));
    const source = join(tempDirectory, "source");
    const mirror = join(tempDirectory, "mirror.git");
    const checkout = join(tempDirectory, "checkout");
    const git = (cwd: string, ...args: string[]) =>
      execFileSync("git", args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();

    execFileSync("git", ["init", "--quiet", source]);
    git(source, "config", "user.email", "test@example.invalid");
    git(source, "config", "user.name", "Workflow checkout test");
    writeFileSync(join(source, "revision.txt"), "mirror revision\n");
    git(source, "add", "revision.txt");
    git(source, "commit", "--quiet", "-m", "mirror revision");
    execFileSync("git", ["clone", "--quiet", "--bare", source, mirror]);

    writeFileSync(join(source, "revision.txt"), "requested but not mirrored\n");
    git(source, "commit", "--quiet", "-am", "requested revision");
    const requestedCommit = git(source, "rev-parse", "HEAD");

    mkdirSync(checkout);
    const result = spawnSync(
      "sh",
      [
        "-c",
        'git clone --depth 1 "$clone_url" . >/dev/null 2>&1 && git fetch --depth 1 origin "$commit_sha" && git checkout --detach "$commit_sha"',
      ],
      {
        cwd: checkout,
        env: { ...process.env, clone_url: `file://${mirror}`, commit_sha: requestedCommit },
        encoding: "utf8",
        stdio: ["ignore", "pipe", "pipe"],
      },
    );

    expect(result.status).not.toBe(0);
    expect(git(checkout, "rev-parse", "HEAD")).not.toBe(requestedCommit);
    expect(readFileSync(join(checkout, "revision.txt"), "utf8")).toBe("mirror revision\n");
  });
});
