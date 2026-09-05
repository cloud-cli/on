import { spawn, exec, ChildProcess } from 'node:child_process';
import fs from 'node:fs';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { promisify } from 'node:util';
import { ExecutionDriver, StepContext, StepExecutionHandle, StepResult } from '../types.js';
import { debug } from '../debug.js';

const execAsync = promisify(exec);

export class SystemdDriver implements ExecutionDriver {
  name = 'systemd';

  async isSupported(): Promise<boolean> {
    try {
      return fs.existsSync('/run/systemd/system');
    } catch {
      return false;
    }
  }

  execute(ctx: StepContext): StepExecutionHandle {
    let logFd: number | null = null;
    const startTime = Date.now();
    const logFilePath = path.join(ctx.logsDir, `step-${ctx.step.id}.log`);

    try {
      fs.mkdirSync(ctx.logsDir, { recursive: true });
      fs.mkdirSync(ctx.workingDir, { recursive: true });
      fs.chmodSync(ctx.workingDir, 0o777);

      logFd = fs.openSync(logFilePath, 'a');
    } catch (err: any) {
      return {
        done: Promise.resolve({
          exitCode: 1,
          durationMs: 0,
          error: new Error(`Failed to initialize step log file: ${err.message}`),
        }),
        cancel: async () => {},
        logFilePath: '',
      };
    }

    const unitName = `workflow-${ctx.jobId}-${ctx.step.id}`.replace(/[^a-zA-Z0-9_-]/g, '_');
    const systemdFlags: string[] = [
      `--unit=${unitName}`,
      '--wait',
      '--pipe',
      '--collect',
      '-p',
      'RemainAfterExit=no',
      `--working-directory=${ctx.workingDir}`,
    ];

    const env = {
      ...(ctx.env || {}),
      PATH: ctx.env?.PATH || process.env.PATH,
    };

    for (const [key, val] of Object.entries(env)) {
      systemdFlags.push(`--setenv=${key}=${val}`);
    }

    if (ctx.timeoutMs) {
      const timeoutSec = Math.ceil(ctx.timeoutMs / 1000);
      systemdFlags.push(`--property=RuntimeMaxSec=${timeoutSec}`);
    }

    let commandArgs: string[];

    if (ctx.image) {
      systemdFlags.push(`--setenv=WORKING_DIR=/workspace`);
      commandArgs = [
        'docker',
        'run',
        '--rm',
        '--init',
        `--name=${unitName}`,
        '-v',
        `${ctx.workingDir}:/workspace`,
        '-w',
        '/workspace',
        ...Object.keys(env).flatMap((k) => ['-e', k]),
        '-e',
        'WORKING_DIR',
        ctx.image,
        'sh',
        '-c',
        ctx.command,
      ];
    } else {
      systemdFlags.push(`--setenv=WORKING_DIR=${ctx.workingDir}`);
      commandArgs = [process.env.SHELL || 'sh', '-e', '-c', ctx.command];
    }

    debug('$ systemd-run', [...systemdFlags, '--', ...commandArgs].join(' '));

    let child: ChildProcess;

    try {
      child = spawn('systemd-run', [...systemdFlags, '--', ...commandArgs], {
        stdio: ['ignore', logFd, logFd],
      });
    } catch (spawnErr: any) {
      try {
        fs.closeSync(logFd);
      } catch {}

      return {
        done: Promise.resolve({
          exitCode: 1,
          durationMs: Date.now() - startTime,
          error: new Error(`Failed to spawn systemd-run: ${spawnErr.message}`),
        }),
        cancel: async () => {},
        logFilePath,
      };
    }

    let isCancelled = false;

    const done = new Promise<StepResult>((resolve) => {
      let isResolved = false;

      const safeResolve = (result: StepResult) => {
        if (isResolved) return; // Prevent double-resolution
        isResolved = true;

        try {
          fs.closeSync(logFd);
        } catch {}

        resolve(result);
      };

      child.on('close', (code, signal) => {
        const exitCode = code !== null ? code : signal ? (isCancelled ? 130 : 1) : 0;
        safeResolve({
          exitCode,
          durationMs: Date.now() - startTime,
          error: isCancelled ? new Error('Step cancelled by user or systemd timeout') : undefined,
        });
      });

      child.on('error', (err) => {
        safeResolve({
          exitCode: 1,
          durationMs: Date.now() - startTime,
          error: err,
        });
      });
    });

    const cancel = async (): Promise<void> => {
      isCancelled = true;

      try {
        if (ctx.image) {
          // Stop docker container gracefully if running
          await execAsync(`docker stop -t 2 ${unitName}`).catch(() => {});
        }

        // Stop systemd transient unit (sends SIGTERM -> SIGKILL to Cgroup tree)
        await execAsync(`systemctl stop ${unitName}.service`).catch(() => {});
      } catch {
        // Unit or container may already be stopped
      }
    };

    return { done, cancel, logFilePath };
  }

  async readLog(file: string) {
    const content = await readFile(file, 'utf-8');
    const start = content.includes('Running as unit: ') ? content.indexOf('\n') + 1 : 0;
    const end = content.includes('Finished with result: ')
      ? content.lastIndexOf('Finished with result: ')
      : content.length;

    return content.slice(start, end);
  }
}
