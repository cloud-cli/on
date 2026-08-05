import fs from 'node:fs';
import path from 'node:path';
import { parseEnv } from 'node:util';
import type { ExecutionDriver, StepContext } from '../types.js';

export async function executeStepAndCollectState(
  stepCtx: StepContext,
  driver: ExecutionDriver,
  currentWorkflowEnv: Record<string, string>,
) {
  // 1. Create temporary state files for this step
  const envFilePath = path.join(stepCtx.workspacePath, `.step-${stepCtx.stepId}.env`);
  const outputFilePath = path.join(stepCtx.workspacePath, `.step-${stepCtx.stepId}.out`);

  fs.writeFileSync(envFilePath, '');
  fs.writeFileSync(outputFilePath, '');

  // 2. Inject environment file paths into step execution context
  const stepEnv = {
    ...currentWorkflowEnv,
    ...stepCtx.env,
    WORKFLOW_ENV: envFilePath,
    WORKFLOW_OUTPUT: outputFilePath,
  };

  // 3. Execute step
  const handle = await driver.execute({ ...stepCtx, env: stepEnv });
  const result = await handle.done;

  if (result.exitCode !== 0) {
    return { result, newEnv: {}, outputs: {} };
  }

  // 4. Parse step-exported environment variables using Node's built-in parseEnv
  const exportedEnvContent = fs.readFileSync(envFilePath, 'utf-8');
  const exportedOutputContent = fs.readFileSync(outputFilePath, 'utf-8');

  const newEnv = parseEnv(exportedEnvContent);
  const outputs = parseEnv(exportedOutputContent);

  // Clean up state files
  fs.unlinkSync(envFilePath);
  fs.unlinkSync(outputFilePath);

  return { result, newEnv, outputs };
}
