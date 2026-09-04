import type { FinalJobStatus, WorkflowContext, WorkflowPlugin } from '../types.js';

export interface GitHubStatusPluginOptions {
  token: string;
  apiUrl?: string;
  context?: string;
}

export class GitHubStatusPlugin implements WorkflowPlugin {
  readonly name = 'github-commit-status';
  private readonly token: string;
  private readonly apiUrl: string;
  private readonly context: string;

  constructor(options: GitHubStatusPluginOptions) {
    this.token = options.token;
    this.apiUrl = options.apiUrl || 'https://api.github.com/';
    this.context = options.context || 'on';
  }

  async onWorkflowStart(wf: WorkflowContext) {
    if (!this.hasCoordinates(wf)) return;

    await this.updateStatus(wf, 'pending', 'Workflow build has started.');
  }

  async onWorkflowFinish(wf: WorkflowContext, status: FinalJobStatus) {
    if (!this.hasCoordinates(wf)) return;

    const state = status === 'success' ? 'success' : status === 'failed' ? 'failure' : 'error';
    const description = status === 'success' ? 'Workflow completed successfully.' : `Workflow ${status}.`;

    await this.updateStatus(wf, state, description);
  }

  private async updateStatus(wf: WorkflowContext, state: string, description: string) {
    const owner = encodeURIComponent(String(wf.inputs.owner));
    const repo = encodeURIComponent(String(wf.inputs.repo));
    const sha = encodeURIComponent(String(wf.inputs.commit_sha));
    const apiUrl = this.apiUrl.endsWith('/') ? this.apiUrl : `${this.apiUrl}/`;
    const response = await fetch(new URL(`repos/${owner}/${repo}/statuses/${sha}`, apiUrl), {
      method: 'POST',
      headers: {
        Accept: 'application/vnd.github+json',
        Authorization: `Bearer ${this.token}`,
        'Content-Type': 'application/json',
        'User-Agent': '@cloud-cli/on',
        'X-GitHub-Api-Version': '2022-11-28',
      },
      signal: AbortSignal.timeout(10_000),
      body: JSON.stringify({
        state,
        target_url: wf.runUrl,
        description: description.slice(0, 140),
        context: `${this.context}/${wf.workflowName}`.slice(0, 100),
      }),
    });

    if (!response.ok) {
      throw new Error(`GitHub status update failed with HTTP ${response.status}: ${await response.text()}`);
    }
  }

  private hasCoordinates(wf: WorkflowContext): boolean {
    return Boolean(this.token && wf.inputs.owner && wf.inputs.repo && wf.inputs.commit_sha);
  }
}
