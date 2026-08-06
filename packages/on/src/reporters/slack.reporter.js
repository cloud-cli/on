export class SlackReporter {
    name = 'slack-reporter';
    token;
    channel;
    notifyOn;
    constructor(options) {
        this.token = options.token;
        this.channel = options.channel;
        this.notifyOn = options.notifyOn || ['failed']; // Default: notify on failure only
    }
    async report(execReport) {
        if (!this.notifyOn.includes(execReport.status))
            return;
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
//# sourceMappingURL=slack.reporter.js.map