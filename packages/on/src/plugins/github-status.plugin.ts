import { WorkflowPlugin, WorkflowContext } from './types.js';

export class GitHubStatusPlugin implements WorkflowPlugin {
  name = 'github-commit-status';

  async onWorkflowStart(wf: WorkflowContext) {
    if (!wf.inputs.commit_sha || !wf.inputs.clone_url) return;

    await this.updateStatus(wf, 'pending', 'Workflow build has started.');
  }

  async onWorkflowFinish(wf: WorkflowContext, status: 'success' | 'failed') {
    if (!wf.inputs.commit_sha || !wf.inputs.clone_url) return;

    const state = status === 'success' ? 'success' : 'failure';
    const description = status === 'success' ? 'All workflow steps passed!' : 'Workflow failed.';

    await this.updateStatus(wf, state, description);
  }

  private async updateStatus(wf: WorkflowContext, state: string, description: string) {
    // Calls GitHub REST API using inputs.commit_sha
    console.log(`[GitHub Plugin] Setting commit status for ${wf.inputs.commit_sha} -> ${state}: ${description}`);
  }
}