import type { WorkflowPlugin, WorkflowPluginDefinition } from "../types.js";

export interface ResolvedWorkflowPluginOptions extends WorkflowPluginDefinition {
  secrets: Record<string, string>;
}

export type WorkflowPluginFactory = (options: ResolvedWorkflowPluginOptions) => WorkflowPlugin;

const workflowPluginRegistry = new Map<string, WorkflowPluginFactory>();

export function registerWorkflowPlugin(name: string, factory: WorkflowPluginFactory): void {
  if (!name.trim()) {
    throw new Error("Workflow plugin name is required");
  }
  workflowPluginRegistry.set(name, factory);
}

export function createWorkflowPlugin(options: ResolvedWorkflowPluginOptions): WorkflowPlugin {
  const factory = workflowPluginRegistry.get(options.name);
  if (!factory) {
    throw new Error(`Unknown workflow plugin '${options.name}'`);
  }
  return factory(options);
}
