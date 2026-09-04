import fs from 'node:fs';
import path from 'node:path';
import { Reporter, WorkflowExecutionReport } from '../types.js';
import { serializeHtmlState } from '../html-state.js';
import htmlTemplate from './html.reporter.html?raw';

const REPORT_STATE_PLACEHOLDER = '__REPORT_STATE__';

export class HtmlReporter implements Reporter {
  name = 'html';
  private outputDir: string;

  constructor(options: { outputDir: string }) {
    this.outputDir = options.outputDir;
  }

  async report(execReport: WorkflowExecutionReport): Promise<void> {
    fs.mkdirSync(this.outputDir, { recursive: true });
    const htmlContent = this.generateHtml(execReport);

    const filePath = path.join(this.outputDir, `run-${execReport.jobId}.html`);
    fs.writeFileSync(filePath, htmlContent, 'utf-8');
    console.log(`📊 HTML Execution Report generated: ${filePath}`);
  }

  generateHtml(execReport: WorkflowExecutionReport): string {
    return htmlTemplate.replace(REPORT_STATE_PLACEHOLDER, () => serializeHtmlState({ report: execReport }));
  }
}
