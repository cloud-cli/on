import { readdir, readFile, stat } from "node:fs/promises";
import path from "node:path";
import { parse as parseYaml } from "yaml";
import type { OnConfig } from "./types.js";
import { existsSync } from "node:fs";

export function toConfigPath(configPath: string): string {
  return path.isAbsolute(configPath)
    ? configPath
    : path.resolve(process.cwd(), configPath);
}

export async function loadConfig(configPath: string): Promise<OnConfig> {
  const fullPath = toConfigPath(configPath);

  if (!existsSync(fullPath)) {
    return { on: {} };
  }

  const files = [];
  const pathStat = await stat(fullPath);

  if (pathStat.isDirectory()) {
    files.push(
      ...(await readdir(fullPath))
        .filter(
          (f) =>
            f.endsWith(".yaml") || f.endsWith(".yml") || f.endsWith(".json"),
        )
        .map((f) => path.join(fullPath, f)),
    );
  } else {
    files.push(fullPath);
  }

  const configs = await Promise.all(files.map(loadConfigFile));

  return configs.reduce(
    (acc, curr) => {
      acc.on = { ...acc.on, ...curr.on };
      return acc;
    },
    { on: {} } as OnConfig,
  );
}

async function loadConfigFile(filePath: string): Promise<OnConfig> {
  const raw = await readFile(filePath, "utf-8");

  if (filePath.endsWith(".yaml") || filePath.endsWith(".yml")) {
    return (parseYaml(raw) ?? { on: {} }) as OnConfig;
  }

  return JSON.parse(raw) as OnConfig;
}
