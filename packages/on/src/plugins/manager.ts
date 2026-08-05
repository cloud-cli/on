import { WorkflowPlugin, WorkflowContext } from './types.js';

export class PluginManager {
  private plugins: WorkflowPlugin[] = [];

  register(plugin: WorkflowPlugin) {
    console.log(`🔌 Registered Plugin: ${plugin.name}`);
    this.plugins.push(plugin);
  }

  async triggerWorkflowStart(wf: WorkflowContext) {
    for (const plugin of this.plugins) {
      if (plugin.onWorkflowStart) {
        await plugin.onWorkflowStart(wf).catch(err =>
          console.error(`[Plugin Error] ${plugin.name}.onWorkflowStart:`, err)
        );
      }
    }
  }

  async triggerWorkflowFinish(wf: WorkflowContext, status: 'success' | 'failed') {
    for (const plugin of this.plugins) {
      if (plugin.onWorkflowFinish) {
        await plugin.onWorkflowFinish(wf, status).catch(err =>
          console.error(`[Plugin Error] ${plugin.name}.onWorkflowFinish:`, err)
        );
      }
    }
  }
}