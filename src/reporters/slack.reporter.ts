import { Reporter, WorkflowExecutionReport } from './types.js';

export class SlackReporter implements Reporter {
  name = 'slack-reporter';
  private token: string;
  private channel: string;
  private notifyOn: ('success' | 'failed')[];

  constructor(options: { token: string; channel: string; notifyOn?: ('success' | 'failed')[] }) {
    this.token = options.token;
    this.channel = options.channel;
    this.notifyOn = options.notifyOn || ['failed']; // Default: notify on failure only
  }

  async report(execReport: WorkflowExecutionReport): Promise<void> {
    if (!this.notifyOn.includes(execReport.status as any)) return;

    const emoji = execReport.status === 'success' ? '✅' : '❌';
    const text = `${emoji} *Workflow ${execReport.workflowName} (#${execReport.jobId})* finished with status: *${execReport.status.toUpperCase()}* (${execReport.durationMs}ms)`;

    await fetch('https://slack.com/api/chat.postMessage', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${this.token}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({ channel: this.channel, text })
    });
  }
}