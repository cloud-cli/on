import { readFile } from "node:fs/promises";
import { asObject } from "./utils.js";

function parseSecretsFile(contents: string): Record<string, string> {
  return contents
    .split(/\r?\n/u)
    .map((line) => line.trim())
    .filter((line) => line.length > 0 && !line.startsWith("#"))
    .reduce<Record<string, string>>((acc, line) => {
      const equalsIndex = line.indexOf("=");
      if (equalsIndex <= 0) {
        return acc;
      }

      const key = line.slice(0, equalsIndex).trim();
      const value = line.slice(equalsIndex + 1).trim();
      acc[key] = value;
      return acc;
    }, {});
}
export async function loadSecrets(
  secretPaths: string[] | undefined,
): Promise<Record<string, string>> {
  const resolved: Record<string, string> = {};

  for (const [key, value] of Object.entries(process.env)) {
    if (typeof value === "string") {
      resolved[key] = value;
    }
  }

  for (const secretPath of secretPaths ?? []) {
    const raw = await readFile(secretPath, "utf8");

    if (secretPath.endsWith(".json")) {
      const parsed = asObject(JSON.parse(raw));
      for (const [key, value] of Object.entries(parsed)) {
        if (value !== undefined && value !== null) {
          resolved[key] = String(value);
        }
      }
      continue;
    }

    Object.assign(resolved, parseSecretsFile(raw));
  }

  return resolved;
}
