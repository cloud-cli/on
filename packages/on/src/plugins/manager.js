export class PluginManager {
    plugins = [];
    register(plugin) {
        console.log(`🔌 Registered Plugin: ${plugin.name}`);
        this.plugins.push(plugin);
    }
    async triggerWorkflowStart(wf) {
        for (const plugin of this.plugins) {
            if (plugin.onWorkflowStart) {
                await plugin.onWorkflowStart(wf).catch(err => console.error(`[Plugin Error] ${plugin.name}.onWorkflowStart:`, err));
            }
        }
    }
    async triggerWorkflowFinish(wf, status) {
        for (const plugin of this.plugins) {
            if (plugin.onWorkflowFinish) {
                await plugin.onWorkflowFinish(wf, status).catch(err => console.error(`[Plugin Error] ${plugin.name}.onWorkflowFinish:`, err));
            }
        }
    }
}
//# sourceMappingURL=manager.js.map