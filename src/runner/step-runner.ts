import { readFileSync, writeFileSync, existsSync, unlinkSync } from 'node:fs';
import path from 'node:path';
import { parseEnv } from 'node:util';
import type { ExecutionDriver, StepContext } from '../types.js';

export async function executeStepAndCollectState(
  stepCtx: StepContext,
  driver: ExecutionDriver,
  currentWorkflowEnv: Record<string, string>,
) {
  const { envFilePath, outputFilePath } = createTmpFiles(stepCtx);

  try {
    const stepEnv = {
      ...currentWorkflowEnv,
      ...stepCtx.env,
      WORKFLOW_ENV: envFilePath,
      WORKFLOW_OUTPUT: outputFilePath,
    };

    const handle = await driver.execute({ ...stepCtx, env: stepEnv });
    const result = await handle.done;

    if (result.exitCode !== 0) {
      return { result, newEnv: {}, outputs: {} };
    }

    const newEnv = parseEnv(readFileSync(envFilePath, 'utf-8'));
    const outputs = parseEnv(readFileSync(outputFilePath, 'utf-8'));

    return { result, newEnv, outputs };
  } finally {
    if (existsSync(envFilePath)) unlinkSync(envFilePath);
    if (existsSync(outputFilePath)) unlinkSync(outputFilePath);
  }
}

function createTmpFiles(stepCtx: StepContext) {
  const envFilePath = path.join(stepCtx.workspacePath, `.step-${stepCtx.stepId}.env`);
  const outputFilePath = path.join(stepCtx.workspacePath, `.step-${stepCtx.stepId}.out`);
  writeFileSync(envFilePath, '');
  writeFileSync(outputFilePath, '');
  return { envFilePath, outputFilePath };
}
