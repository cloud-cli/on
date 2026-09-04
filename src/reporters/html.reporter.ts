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
          : execReport.status === 'running'
            ? 'bg-indigo-500/10 text-indigo-400 border-indigo-500/20'
            : 'bg-amber-500/10 text-amber-400 border-amber-500/20';

    const stepRows = (execReport.steps ?? [])
      .map((step, idx) => {
        const rawLog = step.logContent;
        const htmlLog =
          step.status === 'skipped'
            ? ''
            : step.status === 'running'
              ? '<span class="text-indigo-400">Step is running. Logs will appear after it finishes.</span>'
              : step.status === 'pending'
                ? '<span class="text-gray-500">Waiting to run.</span>'
                : rawLog
                  ? this.ansiUp.ansi_to_html(rawLog)
                  : '<span class="text-gray-500">(No terminal log output recorded for this step)</span>';

        const stepBadge =
          step.status === 'success'
            ? 'text-emerald-400 bg-emerald-500/10'
            : step.status === 'failed'
              ? 'text-rose-400 bg-rose-500/10'
              : step.status === 'running'
                ? 'text-indigo-400 bg-indigo-500/10'
                : 'text-gray-400 bg-gray-500/10';

        return `<details class="border border-b-0 border-gray-800 bg-gray-900/50 text-sm">
          <summary class="flex items-center justify-between p-2 bg-gray-800/40 border-b border-gray-800 cursor-pointer">
            <div class="flex items-center gap-3">
              <span class="font-mono text-gray-500">#${idx + 1} ${step.exitCode !== undefined && step.exitCode !== 0 ? '(' + step.exitCode + ')' : ''}</span>
              <h3 class="font-semibold text-gray-200">${step.name}</h3>
              <span class="px-2.5 py-0.5 rounded-full font-medium ${stepBadge}">
                ${step.status.toUpperCase()}
              </span>
            </div>
            <div class="font-mono text-gray-400">${step.durationMs}ms</div>
          </summary>
          <div class="p-4 bg-gray-950 font-mono text-gray-300 leading-relaxed overflow-auto w-full">
            <pre class="whitespace-pre-wrap">${htmlLog}</pre>
          </div>
        </details>`;
      })
      .join('');

    return `<!DOCTYPE html>
<html lang="en" class="dark">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  ${execReport.status === 'running' || execReport.status === 'pending' ? '<meta http-equiv="refresh" content="3">' : ''}
  <title>Run #${execReport.jobId} - ${execReport.workflowName}</title>
  <script type="importmap"> {"imports": { "@li3/": "https://cdn.li3.dev/@li3/" }}</script>
  <script>
  async function restartJob(jobId) {
    const r = await fetch('/restart/' + jobId, { method:'POST' });
    if (r.ok) {
      const { id } = await r.json();
      location.href = '/runs/' + id
    }
  }
  </script>
</head>
<body class="bg-gray-950 text-gray-100 min-h-screen p-6 font-sans">
  <div class="max-w-5xl mx-auto space-y-4">

    <div class="flex items-center justify-between border-b border-gray-800 pb-6 gap-2">
      <div>
        <a href="/runs" class="text-xs text-indigo-400 hover:underline mb-1 inline-block">← Back to Dashboard</a>
        <h1 class="text-2xl font-bold text-white flex items-center gap-3">
          ${execReport.workflowName}
          <span class="text-sm font-mono text-gray-500">#${execReport.jobId}
          ${ execReport.parentId ? ` -> <a href="/runs/${execReport.parentId}">#${execReport.parentId}</a>` : '' }
          </span>
        </h1>
        <p class="text-xs text-gray-400 mt-1">Started ${execReport.startedAt} • ${execReport.status === 'running' ? `Running for ${execReport.durationMs}ms` : execReport.status === 'pending' ? 'Waiting for a worker' : `Finished in ${execReport.durationMs}ms`}</p>
      </div>
      <div class="flex items-center gap-2">
        <span class="px-4 py-1.5 rounded-full text-sm font-semibold border ${statusColor}">
          ${execReport.status.toUpperCase()}
        </span>
        <button class="text-sm text-white px-4 py-1.5 border border-gray-400 rounded-full" onclick="restartJob('${execReport.jobId}')">restart</button>
      </div>
    </div>

    <div class="rounded overflow-hidden border-b border-gray-800">
      <h2 class="sr-only">Execution Steps</h2>
      ${stepRows}
    </div>

    <details class="bg-gray-900 border border-gray-800 rounded-xl p-4 overflow-auto max-h-[400px]">
      <summary>
        <h2 class="text-xs font-semibold text-gray-400 uppercase tracking-wider mb-2">Trigger Inputs</h2>
      </summary>
      <pre class="font-mono text-xs text-gray-200 bg-gray-950 p-3 rounded-lg overflow-x-auto">${JSON.stringify(execReport.inputs, null, 2)}</pre>
    </details>

  </div>
  <script type="module">import "@li3/web"</script>
  <script src="https://cdn.tailwindcss.com"></script>
</body>
</html>`;
  }
}
