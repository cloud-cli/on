import { readFile } from 'node:fs/promises';
import { parseEnv } from 'node:util';
import { asObject } from './utils.js';

export async function loadSecrets(secretPaths: string[] | undefined): Promise<Record<string, string>> {
  const resolved: Record<string, string> = {};

  for (const [key, value] of Object.entries(process.env)) {
    if (typeof value === 'string') {
      resolved[key] = value;
    }
  }

  for (const secretPath of secretPaths ?? []) {
    const raw = await readFile(secretPath, 'utf8');

    if (secretPath.endsWith('.json')) {
      const parsed = asObject(JSON.parse(raw));
      for (const [key, value] of Object.entries(parsed)) {
        if (value !== undefined && value !== null) {
          resolved[key] = String(value);
        }
      }
      continue;
    }

    Object.assign(resolved, parseEnv(raw));
  }

  return resolved;
}
