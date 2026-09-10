import { describe, expect, it } from 'vitest';
import { createWorkflowPlugin, registerWorkflowPlugin } from './workflow-registry.js';

describe('workflow plugin registry', () => {
  it('creates the built-in GitHub status plugin by name', () => {
    const plugin = createWorkflowPlugin({ name: 'github-status', secrets: { GITHUB_TOKEN: 'token' } });
    expect(plugin.name).toBe('github-commit-status');
  });

  it('supports externally registered plugin factories', () => {
    registerWorkflowPlugin('test-plugin', () => ({
      name: 'test-plugin',
    }));

    expect(createWorkflowPlugin({ name: 'test-plugin', secrets: {} }).name).toBe('test-plugin');
  });
});
