import { readFile } from "node:fs/promises";
import path from "node:path";
import { parse as parseYaml } from "yaml";
import type { OnConfig } from "./types.js";

export function toConfigPath(configPath: string): string {
  return path.isAbsolute(configPath)
    ? configPath
    : path.resolve(process.cwd(), configPath);
}

export async function loadConfig(configPath?: string): Promise<OnConfig> {
  if (!configPath) {
    return {};
  }

  const resolvedPath = toConfigPath(configPath);
  const raw = await readFile(resolvedPath, "utf8");

  if (resolvedPath.endsWith(".yaml") || resolvedPath.endsWith(".yml")) {
    return (parseYaml(raw) ?? {}) as OnConfig;
  }

  return JSON.parse(raw) as OnConfig;
}
