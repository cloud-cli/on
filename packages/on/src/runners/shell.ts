import { spawn } from 'node:child_process';
import type { StepDefinition, StepOutput, WorkflowContext, WorkflowDefinition, WorkflowEvent } from '../types.js';
import { interpolate } from '../utils.js';
import { join, resolve } from 'node:path';
import { DEBUG } from '../env.js';

const SHELL = process.env.SHELL || '/bin/sh';

export async function setup(_wf: WorkflowDefinition, _event: WorkflowEvent) {
  // TODO
}

export async function run(
  _wf: WorkflowDefinition,
  _event: WorkflowEvent,
  step: StepDefinition,
  context: WorkflowContext,
): Promise<StepOutput> {
  const stdout: Buffer[] = [];
  const stderr: Buffer[] = [];
  const cmd = interpolate(step.run, context);
  const workingDir = step.workingDir ? join(context.workingDir, resolve('/', step.workingDir)) : context.workingDir;
  const shell = spawn(SHELL, {
    shell: true,
    env: context.env,
    cwd: workingDir,
  });

  shell.stdout.on('data', (data) => stdout.push(data));
  shell.stderr.on('data', (data) => stderr.push(data));

  return new Promise<StepOutput>((resolve, reject) => {
    shell.once('error', reject);
    shell.once('exit', (code) => {
      const stepOutput = {
        code: code ?? 0,
        cmd: step.run,
        stdout: Buffer.concat(stdout).toString('utf-8'),
        stderr: Buffer.concat(stderr).toString('utf-8'),
      };

      // TODO read and update env

      resolve(stepOutput);
    });

    if (DEBUG) {
      console.log('SHELL', cmd);
    }

    shell.stdin.write(cmd + '\n\nexit $?;\n');
    shell.stdin.end();
  });
}
