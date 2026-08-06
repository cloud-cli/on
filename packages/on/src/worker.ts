import { resolveDriver } from './drivers/index.js';
import { SafeExpressionEvaluator } from './evaluator/safe-eval.js';
import { QueueManager } from './queue/dispatcher.js';
import { SecretStore } from './secrets/store.js';
import { StepContext } from './types.js';

export function startWorkers(count, queue: QueueManager, secrets: SecretStore, config: any) {
  return Array(count).fill((_, i) => startWorkerLoop(`worker-${i}`, queue, secrets, config));
}

export async function startWorkerLoop(workerId: string, queue: QueueManager, secrets: SecretStore, config: any) {
  const driver = await resolveDriver();
  console.log(`[${workerId}] 🚀 Worker started. Driver: ${driver.name}`);

  while (true) {
    try {
      // 1. Claim oldest pending job
      const job = await queue.claimNextJob();

      if (!job) {
        // Sleep for 2 seconds before polling again
        await new Promise((r) => setTimeout(r, 2000));
        continue;
      }

      console.log(`\n[${workerId}] 📦 Claimed Job #${job.id} (Workflow: ${job.workflow_id})`);

      const payload = typeof job.payload === 'string' ? JSON.parse(job.payload) : job.payload;
      const steps = payload.steps || [];
      const inputs = payload.inputs || {};
      let jobFailed = false;

      // In-memory step execution context
      const executionContext = {
        inputs,
        env: { ...config.env },
        secrets: secrets.getAll(),
        steps: {} as Record<string, any>,
      };

      // 2. Execute Steps Sequentially
      for (let i = 0; i < steps.length; i++) {
        const step = steps[i];
        const stepId = step.id || `step-${i}`;
        console.log(`[${workerId}] ▶️ Running step ${i + 1}/${steps.length}: ${step.name || stepId}`);

        // A. Handle `eval:` step (In-Process JS)
        if (step.eval) {
          try {
            const evalResult = await SafeExpressionEvaluator.evaluateAsync(step.eval, executionContext);
            executionContext.steps[stepId] = { status: 'success', outputs: evalResult };
            console.log(`[${workerId}] ✅ JS Eval step [${stepId}] complete.`);
          } catch (evalErr: any) {
            console.error(`[${workerId}] ❌ JS Eval step [${stepId}] failed:`, evalErr.message);
            executionContext.steps[stepId] = { status: 'failed', error: evalErr.message };
            jobFailed = true;
            break;
          }
          continue;
        }

        // B. Handle `run:` step (Out-of-Process Shell/Docker)
        const stepCtx: StepContext = {
          jobId: job.id.toString(),
          stepId,
          workspacePath: `${config.storagePath || '/tmp/workspaces'}/job-${job.id}`,
          command: step.run,
          image: step.image,
          env: {
            ...executionContext.env,
            ...step.env,
          },
          timeoutMs: step.timeoutMs,
        };

        const handle = await driver.execute(stepCtx);

        // Periodically check if job was cancelled in DB
        const cancelCheckInterval = setInterval(async () => {
          if (await queue.isCancelled(job.id)) {
            console.log(`[${workerId}] 🛑 Job #${job.id} was cancelled! Halting execution.`);
            clearInterval(cancelCheckInterval);
            await handle.cancel();
          }
        }, 3000);

        const result = await handle.done;
        clearInterval(cancelCheckInterval);

        if (result.exitCode !== 0) {
          console.error(`[${workerId}] ❌ Step [${stepId}] failed with exit code ${result.exitCode}`);
          executionContext.steps[stepId] = { status: 'failed', exitCode: result.exitCode };
          jobFailed = true;
          break;
        }

        executionContext.steps[stepId] = { status: 'success', exitCode: 0 };
      }

      // 3. Complete Job
      await queue.finishJob(job.id, jobFailed ? 'failed' : 'success');
      console.log(`[${workerId}] ✅ Job #${job.id} completed as: ${jobFailed ? 'failed' : 'success'}`);
    } catch (error) {
      console.error(`[${workerId}] ⚠️ Worker execution error:`, error);
      await new Promise((r) => setTimeout(r, 5000));
    }
  }
}
