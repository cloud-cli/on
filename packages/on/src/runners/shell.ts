import { spawn } from 'node:child_process';
import type { StepDefinition, StepOutput, WorkflowContext, WorkflowDefinition, WorkflowEvent } from '../types.js';

const SHELL = process.env.SHELL || '/bin/sh';

export async function prepare(wf: WorkflowDefinition, event: WorkflowEvent) {
  // TODO
}

export async function run(
  wf: WorkflowDefinition,
  event: WorkflowEvent,
  step: StepDefinition,
  context: WorkflowContext,
): Promise<StepOutput> {
  const stdout: any[] = [];
  const stderr: any[] = [];
  const shell = spawn(SHELL, {
    shell: true,
    env: context.env,
    cwd: step.workingDir || context.workingDir,
  });

  shell.stdout?.on('data', (data) => stdout.push(data));
  shell.stderr?.on('data', (data) => stderr.push(data));

  return new Promise<StepOutput>((resolve, reject) => {
    shell.once('error', reject);
    shell.once('exit', (code) => {
      const stepOutput = {
        code: code ?? 0,
        cmd: step.run,
        stdout: Buffer.concat(stdout).toString('utf-8'),
        stderr: Buffer.concat(stderr).toString('utf-8'),
      };

      resolve(stepOutput);
    });

    shell.stdin?.write(cmd);
    shell.stdin?.write('\nexit $?;\n');
    shell.stdin?.end();
  });
}
