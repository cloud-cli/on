export class GitHubStatusPlugin {
    name = 'github-commit-status';
    async onWorkflowStart(wf) {
        if (!wf.inputs.commit_sha || !wf.inputs.clone_url)
            return;
        await this.updateStatus(wf, 'pending', 'Workflow build has started.');
    }
    async onWorkflowFinish(wf, status) {
        if (!wf.inputs.commit_sha || !wf.inputs.clone_url)
            return;
        const state = status === 'success' ? 'success' : 'failure';
        const description = status === 'success' ? 'All workflow steps passed!' : 'Workflow failed.';
        await this.updateStatus(wf, state, description);
    }
    async updateStatus(wf, state, description) {
        // Calls GitHub REST API using inputs.commit_sha
        console.log(`[GitHub Plugin] Setting commit status for ${wf.inputs.commit_sha} -> ${state}: ${description}`);
    }
}
//# sourceMappingURL=github-status.plugin.js.map