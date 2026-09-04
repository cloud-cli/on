import type { FinalJobStatus, WorkflowContext, WorkflowPlugin } from '../types.js';

export class PluginManager {
  constructor(private plugins: WorkflowPlugin[] = []) {}

  register(plugin: WorkflowPlugin) {
    console.log(`🔌 Registered Plugin: ${plugin.name}`);
    this.plugins.push(plugin);
  }

  async triggerWorkflowStart(wf: WorkflowContext): Promise<void> {
    for (const plugin of this.plugins) {
      if (plugin.onWorkflowStart) {
        try {
          await plugin.onWorkflowStart(wf);
        } catch (err) {
          console.error(`[Plugin Error] ${plugin.name}.onWorkflowStart:`, err);
        }
      }
    }
  }

  async triggerWorkflowFinish(wf: WorkflowContext, status: FinalJobStatus): Promise<void> {
    for (const plugin of this.plugins) {
      if (plugin.onWorkflowFinish) {
        try {
          await plugin.onWorkflowFinish(wf, status);
        } catch (err) {
          console.error(`[Plugin Error] ${plugin.name}.onWorkflowFinish:`, err);
        }
      }
    }
  }
}
