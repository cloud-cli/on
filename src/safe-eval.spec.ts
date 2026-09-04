import { mkdtempSync, writeFileSync } from 'node:fs';
import { rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { SafeExpressionEvaluator, workspaceFiles } from './safe-eval.js';

describe('workspace file helpers', () => {
  const directories: string[] = [];

  afterEach(async () => {
    await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
  });

  it('checks files relative to the claimed job workspace', async () => {
    const workingDir = mkdtempSync(join(tmpdir(), 'on-workspace-'));
    directories.push(workingDir);
    writeFileSync(join(workingDir, 'Dockerfile'), 'FROM scratch');

    await expect(SafeExpressionEvaluator.evaluateConditions("files.exists('Dockerfile')", { files: workspaceFiles(workingDir) })).resolves.toBe(true);
    await expect(SafeExpressionEvaluator.evaluateConditions("files.exists('missing')", { files: workspaceFiles(workingDir) })).resolves.toBe(false);
  });

  it('does not permit paths outside the workspace', () => {
    const files = workspaceFiles('/tmp/on-workspace');
    expect(() => files.exists('../outside')).toThrow('escapes working directory');
  });
});
