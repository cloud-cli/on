import fs from 'node:fs';
import path from 'node:path';
import { AnsiUp } from 'ansi_up';
import { Reporter, WorkflowExecutionReport } from '../types.js';

export class HtmlReporter implements Reporter {
  name = 'html';
  private outputDir: string;
  private ansiUp: AnsiUp;

  constructor(options: { outputDir: string }) {
    this.outputDir = options.outputDir;
    this.ansiUp = new AnsiUp();
    this.ansiUp.use_classes = false; // Inline CSS styling for portability
  }

  async report(execReport: WorkflowExecutionReport): Promise<void> {
    fs.mkdirSync(this.outputDir, { recursive: true });
    const htmlContent = this.generateHtml(execReport);

    const filePath = path.join(this.outputDir, `run-${execReport.jobId}.html`);
    fs.writeFileSync(filePath, htmlContent, 'utf-8');
    console.log(`📊 HTML Execution Report generated: ${filePath}`);
  }

  /**
   * Render standalone HTML template using Tailwind CSS via CDN
   */
  generateHtml(execReport: WorkflowExecutionReport): string {
    const statusColor =
      execReport.status === 'success'
        ? 'bg-emerald-500/10 text-emerald-400 border-emerald-500/20'
        : execReport.status === 'failed'
          ? 'bg-rose-500/10 text-rose-400 border-rose-500/20'
          : 'bg-amber-500/10 text-amber-400 border-amber-500/20';

    const stepRows = execReport.steps
      .map((step, idx) => {
        let rawLog = step.logContent;
        if (!rawLog && step.logFilePath && fs.existsSync(step.logFilePath)) {
          try {
            rawLog = fs.readFileSync(step.logFilePath, 'utf-8');
          } catch {}
        }

        const htmlLog = rawLog
          ? this.ansiUp.ansi_to_html(rawLog)
          : '<span class="text-gray-500">(No terminal log output recorded for this step)</span>';

        const stepBadge =
          step.status === 'success'
            ? 'text-emerald-400 bg-emerald-500/10'
            : step.status === 'failed'
              ? 'text-rose-400 bg-rose-500/10'
              : 'text-gray-400 bg-gray-500/10';

        return `
        <div class="border border-gray-800 rounded-xl overflow-hidden bg-gray-900/50 mb-4">
          <div class="flex items-center justify-between p-4 bg-gray-800/40 border-b border-gray-800">
            <div class="flex items-center gap-3">
              <span class="text-xs font-mono text-gray-500">#${idx + 1} ${step.exitCode !== 0 ? '(' + step.exitCode + ')' : ''}</span>
              <h3 class="font-semibold text-gray-200">${step.name}</h3>
              <span class="px-2.5 py-0.5 rounded-full text-xs font-medium ${stepBadge}">
                ${step.status.toUpperCase()}
              </span>
            </div>
            <div class="text-sm font-mono text-gray-400">${step.durationMs}ms</div>
          </div>
          <div class="p-4 bg-gray-950 font-mono text-xs overflow-x-auto text-gray-300 leading-relaxed max-h-96">
            <pre class="whitespace-pre-wrap">${htmlLog}</pre>
          </div>
        </div>
      `;
      })
      .join('');

    return `<!DOCTYPE html>
<html lang="en" class="dark">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Run #${execReport.jobId} - ${execReport.workflowName}</title>
  <script src="https://cdn.tailwindcss.com"></script>
</head>
<body class="bg-gray-950 text-gray-100 min-h-screen p-6 font-sans">
  <div class="max-w-5xl mx-auto space-y-6">

    <!-- Top Header -->
    <div class="flex items-center justify-between border-b border-gray-800 pb-6">
      <div>
        <a href="/runs" class="text-xs text-indigo-400 hover:underline mb-1 inline-block">← Back to Dashboard</a>
        <h1 class="text-2xl font-bold text-white flex items-center gap-3">
          ${execReport.workflowName}
          <span class="text-sm font-mono text-gray-500">#${execReport.jobId}</span>
        </h1>
        <p class="text-xs text-gray-400 mt-1">Started ${execReport.startedAt} • Finished in ${execReport.durationMs}ms</p>
      </div>
      <span class="px-4 py-1.5 rounded-full text-sm font-semibold border ${statusColor}">
        ${execReport.status.toUpperCase()}
      </span>
    </div>

    <!-- Inputs Overview -->
    <div class="bg-gray-900 border border-gray-800 rounded-xl p-4">
      <h2 class="text-xs font-semibold text-gray-400 uppercase tracking-wider mb-2">Trigger Inputs</h2>
      <pre class="font-mono text-xs text-indigo-300 bg-gray-950 p-3 rounded-lg overflow-x-auto">${JSON.stringify(execReport.inputs, null, 2)}</pre>
    </div>

    <!-- Steps Timeline -->
    <div>
      <h2 class="text-lg font-semibold text-white mb-4">Execution Steps</h2>
      ${stepRows}
    </div>

  </div>
</body>
</html>`;
  }
}
