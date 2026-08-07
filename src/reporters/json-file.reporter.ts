import fs from 'node:fs';
import path from 'node:path';
import { Reporter, WorkflowExecutionReport } from '../types.js';

export class JsonFileReporter implements Reporter {
  name = 'json-file-reporter';
  private outputDir: string;

  constructor(options: { outputDir: string }) {
    this.outputDir = options.outputDir;
  }

  async report(execReport: WorkflowExecutionReport): Promise<void> {
    fs.mkdirSync(this.outputDir, { recursive: true });
    const filePath = path.join(this.outputDir, `run-${execReport.jobId}.json`);

    // Save pretty-printed execution report
    fs.writeFileSync(filePath, JSON.stringify(execReport, null, 2), 'utf-8');
    console.log(`📊 Execution report saved to: ${filePath}`);
  }
}
