import fs from 'node:fs';
import path from 'node:path';
import { parseEnv } from 'node:util';
export async function executeStepAndCollectState(stepCtx, driver, currentWorkflowEnv) {
    // 1. Create temporary state files for this step
    const envFilePath = path.join(stepCtx.workspacePath, `.step-${stepCtx.stepId}.env`);
    const outputFilePath = path.join(stepCtx.workspacePath, `.step-${stepCtx.stepId}.out`);
    fs.writeFileSync(envFilePath, '');
    fs.writeFileSync(outputFilePath, '');
    let newEnv = {};
    let outputs = {};
    try {
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
        // 4. Parse step-exported environment variables using Node's built-in parseEnv
        if (fs.existsSync(envFilePath)) {
            newEnv = parseEnv(fs.readFileSync(envFilePath, 'utf-8'));
        }
        if (fs.existsSync(outputFilePath)) {
            outputs = parseEnv(fs.readFileSync(outputFilePath, 'utf-8'));
        }
        if (result.exitCode !== 0) {
            return { result, newEnv: {}, outputs: {} };
        }
        return { result, newEnv, outputs };
    }
    finally {
        // ALWAYS cleans up temp state files, regardless of success or failure
        if (fs.existsSync(envFilePath))
            fs.unlinkSync(envFilePath);
        if (fs.existsSync(outputFilePath))
            fs.unlinkSync(outputFilePath);
    }
}
//# sourceMappingURL=step-runner.js.map