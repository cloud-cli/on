import fs from 'node:fs';
import path from 'node:path';
export class JsonFileReporter {
    name = 'json-file-reporter';
    outputDir;
    constructor(options) {
        this.outputDir = options.outputDir;
    }
    async report(execReport) {
        fs.mkdirSync(this.outputDir, { recursive: true });
        const filePath = path.join(this.outputDir, `run-${execReport.jobId}.json`);
        // Save pretty-printed execution report
        fs.writeFileSync(filePath, JSON.stringify(execReport, null, 2), 'utf-8');
        console.log(`📊 Execution report saved to: ${filePath}`);
    }
}
//# sourceMappingURL=json-file.reporter.js.map