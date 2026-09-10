import { describe, expect, it } from 'vitest';
import { expandMatrix, resolveMatrixTags } from './matrix-expander.js';

describe('expandMatrix', () => {
  it('creates one runtime variant for each Cartesian combination', () => {
    const variants = expandMatrix({
      id: 'build',
      name: 'Build',
      matrix: { node: [18, 20], os: ['linux', 'macos'] },
      on: { provider: 'generic' },
      steps: [{ run: 'echo test' }],
    });

    expect(variants).toHaveLength(4);
    expect(variants.map((variant) => variant.matrixContext)).toEqual([
      { node: 18, os: 'linux' },
      { node: 18, os: 'macos' },
      { node: 20, os: 'linux' },
      { node: 20, os: 'macos' },
    ]);
    expect(variants[0].env).toMatchObject({ MATRIX_NODE: '18', MATRIX_OS: 'linux' });
    expect(variants[0].name).toBe('Build (node=18, os=linux)');
  });
});

describe('resolveMatrixTags', () => {
  it('resolves each matrix variant to its required AND tags', async () => {
    await expect(resolveMatrixTags(['${matrix.runner}', 'docker'], { runner: 'alpha' })).resolves.toEqual(['alpha', 'docker']);
  });
});
