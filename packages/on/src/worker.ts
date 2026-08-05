import { QueueManager } from './queue/dispatcher.js';
import { resolveDriver } from './drivers/index.js';
import { StepContext } from './types.js';
import os from 'node:os';

async function startWorker() {
  const workerId = `worker-${os.hostname()}-${process.pid}`;
  const queue = new QueueManager(workerId);
  await queue.init();

  const driver = await resolveDriver();
  console.log(`[${workerId}] 🚀 Worker started. Driver: ${driver.name}`);

  // Polling Loop
  while (true) {
    try {
      // 1. Try to claim a job
      const job = await queue.claimNextJob();

      if (!job) {
        // No jobs available, sleep for 3 seconds before polling again
        await new Promise(r => setTimeout(r, 3000));
        continue;
      }

      console.log(`\n[${workerId}] 📦 Claimed Job #${job.id} (Workflow: ${job.workflow_id})`);

      const payload = JSON.parse(job.payload);
      const steps = payload.steps || []; // Assuming payload contains an array of steps
      let jobFailed = false;

      // 2. Execute Steps Sequentially
      for (let i = 0; i < steps.length; i++) {
        const step = steps[i];
        console.log(`[${workerId}] ▶️ Running step ${i + 1}/${steps.length}: ${step.name}`);

        const stepCtx: StepContext = {
          jobId: job.id.toString(),
          stepId: `step-${i}`,
          workspacePath: `/tmp/workspaces/job-${job.id}`,
          command: step.run,
          image: step.image,
          env: step.env
        };

        const handle = await driver.execute(stepCtx);
        console.log(`[${workerId}] 📝 Logs: ${handle.logFilePath}`);

        // Background task: Check for cancellation while step runs
        const cancelCheckInterval = setInterval(async () => {
          if (await queue.isCancelled(job.id)) {
            console.log(`[${workerId}] 🛑 Job #${job.id} was cancelled! Halting step.`);
            clearInterval(cancelCheckInterval);
            await handle.cancel();
          }
        }, 5000); // Check DB every 5 seconds for a cancellation signal

        // Wait for step to finish
        const result = await handle.done;
        clearInterval(cancelCheckInterval);

        if (result.exitCode !== 0) {
          console.error(`[${workerId}] ❌ Step failed with code ${result.exitCode}`);
          jobFailed = true;
          break; // Stop running further steps in this job
        }
      }

      // 3. Mark Job as Finished
      await queue.finishJob(job.id, jobFailed ? 'failed' : 'success');
      console.log(`[${workerId}] ✅ Job #${job.id} finished with status: ${jobFailed ? 'failed' : 'success'}`);

    } catch (error) {
      console.error(`[${workerId}] ⚠️ Fatal Worker Error:`, error);
      await new Promise(r => setTimeout(r, 5000)); // Backoff on error
    }
  }
}

startWorker();