import { spawn, exec } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { promisify } from 'node:util';
import { ExecutionDriver, StepContext, StepExecutionHandle, StepResult } from '../types.js';

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

  async execute(ctx: StepContext): Promise<StepExecutionHandle> {
    const startTime = Date.now();
    let logFd: number | null = null;
    let logFilePath = '';

    try {
      const logDir = path.join(ctx.workspacePath, '.logs');
      fs.mkdirSync(logDir, { recursive: true });
      logFilePath = path.join(logDir, `step-${ctx.stepId}.log`);
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

    const unitName = `workflow-${ctx.jobId}-${ctx.stepId}`.replace(/[^a-zA-Z0-9_-]/g, '_');

    const systemdFlags: string[] = [
      `--unit=${unitName}`,
      '--wait', // Block until unit completes
      '--pipe', // Stream stdio directly to file handle
      `--working-directory=${ctx.workspacePath}/wd`,
    ];

    if (ctx.env) {
      for (const [key, val] of Object.entries(ctx.env)) {
        systemdFlags.push(`--setenv=${key}=${val}`);
      }
    }

    if (ctx.timeoutMs) {
      const timeoutSec = Math.ceil(ctx.timeoutMs / 1000);
      systemdFlags.push(`--property=RuntimeMaxSec=${timeoutSec}`);
    }

    let commandArgs: string[];

    if (ctx.image) {
      commandArgs = [
        'docker',
        'run',
        '--rm',
        '--init',
        `--name=${unitName}`,
        '-v',
        `${ctx.workspacePath}/wd:/workspace`,
        '-w',
        '/workspace',
        ctx.image,
        'sh',
        '-c',
        ctx.command,
      ];
    } else {
      commandArgs = [process.env.SHELL || 'sh', '-c', ctx.command];
    }

    fs.mkdirSync(`${ctx.workspacePath}/wd`, { recursive: true });

    // 5. Spawn systemd-run
    let child;
    try {
      child = spawn('systemd-run', [...systemdFlags, '--', ...commandArgs], {
        stdio: ['ignore', logFd, logFd],
      });
    } catch (spawnErr: any) {
      try {
        if (logFd !== null) fs.closeSync(logFd);
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
          if (logFd !== null) fs.closeSync(logFd);
        } catch {}

        resolve(result);
      };

      child.on('close', (code) => {
        safeResolve({
          exitCode: code ?? (isCancelled ? 130 : 1),
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
}
