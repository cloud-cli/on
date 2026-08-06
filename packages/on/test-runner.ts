import { StandardProcessDriver } from './drivers/standard-process.driver.js';
import fs from 'node:fs';
import path from 'node:path';

async function runTest() {
  const driver = new StandardProcessDriver();
  const workspacePath = path.resolve('./tmp-workspace');
  fs.mkdirSync(workspacePath, { recursive: true });

  console.log('🚀 Launching Step Execution...');

  const handle = await driver.execute({
    jobId: 'job-001',
    stepId: 'step-build',
    workspacePath,
    command: 'echo "Starting build..." && sleep 2 && echo "Build Complete!"',
    env: { NODE_ENV: 'production' },
  });

  console.log(`📝 Logs streaming directly to: ${handle.logFilePath}`);

  const result = await handle.done;
  console.log('✅ Step Finished!', result);

  // Print captured logs from disk
  const logs = fs.readFileSync(handle.logFilePath, 'utf-8');
  console.log('\n--- CAPTURED LOGS ---');
  console.log(logs);
}

runTest();
