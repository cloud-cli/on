import { beforeEach, describe, expect, it, vi } from "vitest";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const database = vi.hoisted(() => ({
  get: vi.fn(),
  all: vi.fn(),
  run: vi.fn(),
  exec: vi.fn(),
  transaction: vi.fn(),
}));
vi.mock("./db-client.js", () => ({ default: database }));

import { parseRecipe, RecipeRepository } from "./recipes.js";

describe("global recipe repository identity and versioning", () => {
  beforeEach(() => vi.resetAllMocks());

  it("normalizes a preferred username once and retains its namespace after username changes", async () => {
    database.get
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce({ namespace: "ada-lovelace" })
      .mockResolvedValueOnce({ namespace: "ada-lovelace" });
    const repository = new RecipeRepository();
    await expect(repository.getOrCreateNamespace("oidc-subject", "Ada Lovelace")).resolves.toBe("ada-lovelace");
    await expect(repository.getOrCreateNamespace("oidc-subject", "ada-renamed")).resolves.toBe("ada-lovelace");
    expect(database.run).toHaveBeenCalledWith(expect.stringContaining("INSERT INTO recipe_publishers"), [
      "oidc-subject",
      "ada-lovelace",
    ]);
  });

  it("allocates a version transactionally and returns the version tied to this publication", async () => {
    let publishId = "";
    database.transaction.mockImplementation(async (statements: Array<{ s: string; d: unknown[] }>) => {
      const insert = statements.find((statement) => statement.s.includes("INSERT INTO recipe_versions"));
      publishId = String(insert?.d[5]);
    });
    database.get.mockImplementation(async (sql: string) => {
      if (sql.includes("WHERE publish_id")) {
        return { version: 2 };
      }
      if (sql.includes("SELECT owner_subject FROM recipes")) {
        return { owner_subject: "oidc-subject" };
      }
      return null;
    });
    const recipe = await new RecipeRepository().publish(
      "ada-lovelace",
      "deploy",
      "Deploy",
      "oidc-subject",
      "inputs: { image: { type: string, required: true } }\nsecrets: { credential: { type: file } }\nenv: { IMAGE: '\${inputs.image}' }\nsteps: [{ run: 'npm run deploy' }]\n",
    );
    expect(recipe.version).toBe(2);
    expect(publishId).toMatch(/^[0-9a-f-]{36}$/);
    const statements = database.transaction.mock.calls[0][0];
    const versionInsert = statements.find((statement: { s: string }) =>
      statement.s.includes("INSERT INTO recipe_versions"),
    );
    expect(versionInsert.s).toContain("MAX(version)");
    expect(versionInsert.s).toContain("owner_subject=?");
    expect(JSON.parse(versionInsert.d[9] as string)).toEqual({
      main: {
        inputs: {
          type: "object",
          properties: { image: { type: "string" } },
          required: ["image"],
        },
        secrets: { credential: { type: "file" } },
        outputs: { type: "object" },
        steps: [{ run: "npm run deploy" }],
      },
    });
    expect(JSON.parse(versionInsert.d[7] as string)).toMatchObject({
      properties: { image: { type: "string" } },
      required: ["image"],
    });
    expect(JSON.parse(versionInsert.d[10] as string)).toEqual({
      IMAGE: "${inputs.image}",
    });
    expect(recipe.functions).toEqual(JSON.parse(versionInsert.d[9] as string));
    expect(recipe.env).toEqual({ IMAGE: "${inputs.image}" });
  });

  it("adds functions_json to existing installations and normalizes legacy rows on read", async () => {
    database.all.mockResolvedValue([]);
    database.get.mockImplementation(async (sql: string) =>
      sql.includes("recipe_publishers") || sql.includes("FROM recipes")
        ? { owner_subject: "system:built-in-recipes" }
        : null,
    );
    const repository = new RecipeRepository();
    await repository.init();
    expect(database.exec).toHaveBeenCalledWith("ALTER TABLE recipe_versions ADD COLUMN functions_json TEXT");
    expect(database.exec).toHaveBeenCalledWith(
      "ALTER TABLE recipe_versions ADD COLUMN env_json TEXT NOT NULL DEFAULT '{}'",
    );

    database.get.mockResolvedValue({
      namespace: "ada",
      slug: "legacy",
      version: 1,
      name: "Legacy",
      source_yaml: "",
      revoked: 0,
      inputs_json: '{"type":"object","properties":{}}',
      steps_json: '[{"run":"echo hi"}]',
      functions_json: null,
    });
    await expect(repository.get("ada", "legacy", 1)).resolves.toMatchObject({
      functions: {
        main: {
          inputs: { type: "object", properties: {} },
          outputs: { type: "object" },
          steps: [{ run: "echo hi" }],
        },
      },
    });
  });

  it("seeds the immutable system docker build recipe idempotently", async () => {
    database.all.mockResolvedValue([]);
    database.get.mockImplementation(async (sql: string) => {
      if (sql.includes("recipe_publishers")) {
        return { owner_subject: "system:built-in-recipes" };
      }
      if (sql.includes("FROM recipes")) {
        return { owner_subject: "system:built-in-recipes" };
      }
      return null;
    });
    const repository = new RecipeRepository();
    await repository.init();
    await repository.init();
    const seedVersionRuns = database.run.mock.calls.filter(([sql]) =>
      String(sql).includes("INSERT INTO recipe_versions"),
    );
    expect(seedVersionRuns).toHaveLength(4);
    // Each init seeds v3 and then v4, so the first idempotent pass is indexes 0 and 1.
    // Each INSERT has version as parameter at index 2 and index 11 (WHERE NOT EXISTS clause)
    const v3Params = seedVersionRuns[0][1];
    const v4Params = seedVersionRuns[1][1];
    const yamlV3 = String(seedVersionRuns[0][1][4]); // source_yaml is at index 4
    const recipeV3 = parseRecipe(yamlV3);
    expect(recipeV3.functions.main.inputs.required).toEqual(["image", "registryUsername", "cloneUrl", "commitSha"]);
    expect(recipeV3.functions.main.inputs.properties.imageTag.default).toBe("latest");
    expect(recipeV3.functions.main.secrets).toEqual({
      registryToken: { type: "string", required: true },
      gitMiniToken: { type: "string", required: false },
    });
    expect(yamlV3).not.toContain("cloudyToken");
    expect(yamlV3).toContain('git checkout --detach "$COMMIT_SHA"');
    expect(yamlV3).toContain("https://git.api.apphor.de/git/*");
    expect(yamlV3).toContain("gitMiniToken may only authenticate GitMini clone URLs.");
    expect(yamlV3).toContain('GIT_ASKPASS="$askpass" GIT_TERMINAL_PROMPT=0 git -c http.followRedirects=false clone');
    expect(yamlV3).toContain("if [ ! -f Dockerfile ]; then");
    expect(yamlV3).toContain('cy dx.list --image "$IMAGE_TAG"');
    expect(yamlV3).toContain("| jq -r '.[].name'");
    expect(yamlV3).toContain("No services match image $IMAGE_TAG");
    expect(yamlV3).toContain('cy dx.pull "$service"');
    expect(yamlV3).toContain('cy dx.restart "$service"');
    const yamlV4 = String(seedVersionRuns[1][1][4]); // source_yaml is at index 4
    const recipeV4 = parseRecipe(yamlV4);
    expect(recipeV4.functions.main.inputs.required).toEqual(["image", "registryUsername", "cloneUrl", "commitSha"]);
    expect(recipeV4.functions.main.inputs.properties.imageTag.default).toBe("latest");
    expect(recipeV4.functions.main.secrets).toEqual({
      registryToken: { type: "string", required: true },
      gitMiniToken: { type: "string", required: false },
    });
    expect(recipeV4.env).not.toHaveProperty("GITMINI_TOKEN");
    expect(recipeV4.functions.main.steps[0].env).toEqual({ GITMINI_TOKEN: "${String(secrets.gitMiniToken || '')}" });
    expect(yamlV4).not.toContain("cloudyToken");
    expect(yamlV4).toContain('git checkout --detach "$COMMIT_SHA"');
    expect(yamlV4).toContain("https://git.api.apphor.de/git/*");
    expect(yamlV4).toContain("gitMiniToken may only authenticate GitMini clone URLs.");
    expect(yamlV4).not.toContain('GIT_ASKPASS="$askpass"');
    expect(yamlV4).toContain("GIT_CONFIG_GLOBAL");
    expect(yamlV4).toContain('GIT_CONFIG_GLOBAL="$git_config"');
    expect(yamlV4).toContain("umask 077");
    expect(yamlV4).toContain('[http "https://git.api.apphor.de/git/"]');
    expect(yamlV4).toContain("chmod 600");
    expect(yamlV4).toContain(`trap 'rm -rf "$git_config_dir"' EXIT`);
    expect(yamlV4).toContain("base64");
    // Verify version parameters
    expect(v3Params[2]).toBe(3);
    expect(v3Params[11]).toBe(3);
    expect(v4Params[2]).toBe(4);
    expect(v4Params[11]).toBe(4);
    expect(
      database.run.mock.calls.some(
        ([sql, params]) => String(sql).includes("recipe_publishers") && params.includes("system:built-in-recipes"),
      ),
    ).toBe(true);
  });

  it("uses a temporary private Git config for GitMini auth and rejects other token targets", async () => {
    database.all.mockResolvedValue([]);
    database.get.mockImplementation(async (sql: string) =>
      sql.includes("recipe_publishers") || sql.includes("FROM recipes")
        ? { owner_subject: "system:built-in-recipes" }
        : null,
    );
    await new RecipeRepository().init();
    const seed = database.run.mock.calls.find(
      ([sql, params]) => String(sql).includes("INSERT INTO recipe_versions") && params[2] === 4,
    );
    const recipe = parseRecipe(String(seed?.[1]?.[4]));
    const cloneScript = (recipe.functions.main.steps[0] as { run: string }).run;
    const root = mkdtempSync(join(tmpdir(), "on-gitmini-config-"));
    try {
      const bin = join(root, "bin");
      const work = join(root, "work");
      const argsFile = join(root, "args");
      const configPathFile = join(root, "config-path");
      const configSnapshot = join(root, "git-config-snapshot");
      const configModeFile = join(root, "git-config-mode");
      const configDirectoryModeFile = join(root, "git-config-directory-mode");
      const gitMiniEnvFile = join(root, "gitmini-env");
      const git = join(bin, "git");
      const gitMiniToken = "private-gitmini-token-fixture";
      await import("node:fs/promises").then(({ mkdir }) => mkdir(bin));
      await import("node:fs/promises").then(({ mkdir }) => mkdir(work));
      writeFileSync(
        git,
        `#!/bin/sh\nif [ "$1" = "-c" ]; then shift 2; fi\ncase "$1" in\n  clone)\n    printf '%s\\n' "$@" > "${argsFile}"\n    printf '%s\\n' "$GIT_CONFIG_GLOBAL" > "${configPathFile}"\n    cp "$GIT_CONFIG_GLOBAL" "${configSnapshot}"\n    stat -c '%a' "$GIT_CONFIG_GLOBAL" > "${configModeFile}"\n    stat -c '%a' "$(dirname "$GIT_CONFIG_GLOBAL")" > "${configDirectoryModeFile}"\n    if [ -n "$GITMINI_TOKEN" ]; then printf present > "${gitMiniEnvFile}"; else printf absent > "${gitMiniEnvFile}"; fi\n    [ "$FAIL_CLONE" != "1" ] || exit 23\n    mkdir source\n    ;;\n  checkout) ;;\nesac\n`,
        { mode: 0o700 },
      );
      const runClone = (cloneUrl: string, failClone = false) =>
        execFileSync("bash", ["-euo", "pipefail", "-c", cloneScript], {
          cwd: work,
          env: {
            PATH: `${bin}:/usr/bin:/bin`,
            GITMINI_TOKEN: gitMiniToken,
            CLONE_URL: cloneUrl,
            COMMIT_SHA: "a".repeat(40),
            FAIL_CLONE: failClone ? "1" : "0",
          },
          encoding: "utf8",
          stdio: ["ignore", "pipe", "pipe"],
        });
      const output = runClone("https://git.api.apphor.de/git/team/repository.git");
      const authorization = Buffer.from(`git:${gitMiniToken}`).toString("base64");
      expect(output).not.toContain(gitMiniToken);
      expect(readFileSync(argsFile, "utf8")).toContain("https://git.api.apphor.de/git/team/repository.git");
      expect(readFileSync(argsFile, "utf8")).not.toContain(gitMiniToken);
      const configPath = readFileSync(configPathFile, "utf8").trim();
      const configDirectory = join(configPath, "..");
      const config = readFileSync(configSnapshot, "utf8");
      expect(config).toContain(`Authorization: Basic ${authorization}`);
      expect(config).not.toContain(gitMiniToken);
      expect(readFileSync(configModeFile, "utf8").trim()).toBe("600");
      expect(readFileSync(configDirectoryModeFile, "utf8").trim()).toBe("700");
      expect(readFileSync(gitMiniEnvFile, "utf8")).toBe("absent");
      expect(
        execFileSync(
          "git",
          [
            "config",
            "--file",
            configSnapshot,
            "--get-urlmatch",
            "http.extraHeader",
            "https://git.api.apphor.de/git/team/repository.git",
          ],
          { encoding: "utf8" },
        ),
      ).toBe(`Authorization: Basic ${authorization}\n`);
      expect(() =>
        execFileSync(
          "git",
          [
            "config",
            "--file",
            configSnapshot,
            "--get-urlmatch",
            "http.extraHeader",
            "https://attacker.example/repository.git",
          ],
          { stdio: "ignore" },
        ),
      ).toThrow();
      expect(() => readFileSync(configDirectory)).toThrow();
      expect(() => readFileSync(configPath)).toThrow();

      rmSync(join(work, "source"), { recursive: true, force: true });
      rmSync(argsFile, { force: true });
      rmSync(configPathFile, { force: true });
      rmSync(configSnapshot, { force: true });
      rmSync(configModeFile, { force: true });
      expect(() => runClone("https://git.api.apphor.de/git/team/repository.git", true)).toThrow();
      const failedConfigPath = readFileSync(configPathFile, "utf8").trim();
      expect(() => readFileSync(join(failedConfigPath, ".."))).toThrow();
      expect(() => readFileSync(failedConfigPath)).toThrow();
      rmSync(argsFile, { force: true });
      rmSync(configPathFile, { force: true });
      rmSync(configSnapshot, { force: true });
      rmSync(configModeFile, { force: true });
      rmSync(configDirectoryModeFile, { force: true });
      rmSync(gitMiniEnvFile, { force: true });
      expect(() => runClone("https://attacker.example/git/team/repository.git")).toThrow();
      expect(() => readFileSync(argsFile)).toThrow();
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("checks out only the requested immutable commit and fails closed until a delayed mirror has it", async () => {
    database.all.mockResolvedValue([]);
    database.get.mockImplementation(async (sql: string) =>
      sql.includes("recipe_publishers") || sql.includes("FROM recipes")
        ? { owner_subject: "system:built-in-recipes" }
        : null,
    );
    await new RecipeRepository().init();
    const seed = database.run.mock.calls.find(
      ([sql, params]) => String(sql).includes("INSERT INTO recipe_versions") && params[2] === 4,
    );
    const recipe = parseRecipe(String(seed?.[1]?.[4]));
    const checkoutScript = (recipe.functions.main.steps[0] as { run: string }).run;
    const root = mkdtempSync(join(tmpdir(), "on-exact-commit-"));
    try {
      let remote = join(root, "mirror.git");
      const source = join(root, "source-work");
      const work = join(root, "work");
      const run = (commitSha: string) => {
        rmSync(join(work, "source"), { recursive: true, force: true });
        execFileSync("bash", ["-euo", "pipefail", "-c", checkoutScript], {
          cwd: work,
          env: { PATH: process.env.PATH, GITMINI_TOKEN: "", CLONE_URL: remote, COMMIT_SHA: commitSha },
          encoding: "utf8",
          stdio: ["ignore", "pipe", "pipe"],
        });
        return execFileSync("git", ["-C", join(work, "source"), "rev-parse", "HEAD"], { encoding: "utf8" }).trim();
      };
      execFileSync("git", ["init", "--bare", remote], { stdio: "ignore" });
      execFileSync("git", ["init", source], { stdio: "ignore" });
      execFileSync(
        "git",
        [
          "-C",
          source,
          "-c",
          "user.name=Fixture",
          "-c",
          "user.email=fixture@example.test",
          "commit",
          "--allow-empty",
          "-m",
          "requested",
        ],
        {
          stdio: "ignore",
          env: { ...process.env, GIT_AUTHOR_DATE: "2000-01-01T00:00:00Z", GIT_COMMITTER_DATE: "2000-01-01T00:00:00Z" },
        },
      );
      const requested = execFileSync("git", ["-C", source, "rev-parse", "HEAD"], { encoding: "utf8" }).trim();
      execFileSync("git", ["-C", source, "remote", "add", "origin", remote], { stdio: "ignore" });
      execFileSync("git", ["-C", source, "push", "origin", "HEAD:refs/heads/main"], { stdio: "ignore" });
      execFileSync("git", ["init", work], { stdio: "ignore" });
      expect(() => run("f".repeat(40))).toThrow();
      expect(run(requested)).toBe(requested);

      // A delayed mirror has no requested object initially: fail without checking out its branch head.
      remote = join(root, "delayed-mirror.git");
      execFileSync("git", ["init", "--bare", remote], { stdio: "ignore" });
      execFileSync("git", ["-C", source, "remote", "set-url", "origin", remote], { stdio: "ignore" });
      expect(() => run(requested)).toThrow();
      execFileSync("git", ["-C", source, "push", "origin", "HEAD:refs/heads/main"], { stdio: "ignore" });
      expect(run(requested)).toBe(requested);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("fails closed when the reserved built-in namespace is owned by another publisher", async () => {
    database.all.mockResolvedValue([]);
    database.get.mockResolvedValue({ owner_subject: "human-publisher" });
    await expect(new RecipeRepository().init()).rejects.toThrow(/namespace "on" is owned/);
    expect(database.run).toHaveBeenCalledTimes(1);
  });

  it("returns persisted named functions from list and get", async () => {
    const functions = {
      deploy: {
        inputs: { type: "object" },
        outputs: { type: "object" },
        steps: [{ run: "deploy" }],
      },
    };
    const row = {
      namespace: "ada",
      slug: "named",
      version: 1,
      name: "Named",
      source_yaml: "",
      revoked: 0,
      inputs_json: '{"type":"object"}',
      steps_json: '[{"run":"deploy"}]',
      functions_json: JSON.stringify(functions),
    };
    database.all.mockResolvedValue([row]);
    database.get.mockResolvedValue(row);
    const repository = new RecipeRepository();
    await expect(repository.list()).resolves.toMatchObject([{ functions }]);
    await expect(repository.get("ada", "named", 1)).resolves.toMatchObject({
      functions,
    });
  });
});
