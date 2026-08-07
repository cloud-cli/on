import { Reporter, WorkflowExecutionReport } from '../types.js';

export class SlackReporter implements Reporter {
  readonly name = 'slack';
  private webhookUrl: string = '';
  private token: string = '';
  private channel: string = '';
  private notifyOn: ('success' | 'failed')[] = ['failed'];

  constructor(options: { webhookUrl: string; token: string; channel: string; notifyOn?: ('success' | 'failed')[] }) {
    Object.assign(this, options);
  }

  async report(execReport: WorkflowExecutionReport): Promise<void> {
    if (!this.notifyOn.includes(execReport.status as any)) return;

    const emoji = execReport.status === 'success' ? '✅' : '❌';
    const text = `${emoji} *Workflow ${execReport.workflowName} (#${execReport.jobId})* finished with status: *${execReport.status.toUpperCase()}* (${execReport.durationMs}ms)`;

    await fetch(this.webhookUrl, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${this.token}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ channel: this.channel, text }),
    });
  }
}
