import type { WorkflowPlugin, WorkflowPluginDefinition } from '../types.js';
import { GitHubStatusPlugin } from './github-status.plugin.js';

export interface ResolvedWorkflowPluginOptions extends WorkflowPluginDefinition {
  secrets: Record<string, string>;
}

export type WorkflowPluginFactory = (options: ResolvedWorkflowPluginOptions) => WorkflowPlugin;

const workflowPluginRegistry = new Map<string, WorkflowPluginFactory>();

export function registerWorkflowPlugin(name: string, factory: WorkflowPluginFactory): void {
  if (!name.trim()) throw new Error('Workflow plugin name is required');
  workflowPluginRegistry.set(name, factory);
}

export function createWorkflowPlugin(options: ResolvedWorkflowPluginOptions): WorkflowPlugin {
  const factory = workflowPluginRegistry.get(options.name);
  if (!factory) throw new Error(`Unknown workflow plugin '${options.name}'`);
  return factory(options);
}

registerWorkflowPlugin('github-status', (options) => {
  const token = options.secrets.GITHUB_TOKEN || options.secrets.token;
  if (!token) throw new Error("Plugin 'github-status' requires a GITHUB_TOKEN secret mapping");
  return new GitHubStatusPlugin({ token, context: options.context, apiUrl: options.apiUrl });
});
