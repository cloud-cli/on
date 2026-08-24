import { spawn, ChildProcess } from 'node:child_process';
import fs from 'node:fs';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { ExecutionDriver, StepContext, StepExecutionHandle, StepResult } from '../types.js';

export class StandardProcessDriver implements ExecutionDriver {
  name = 'standard-process';

  async isSupported(): Promise<boolean> {
    return true;
  }

  execute(ctx: StepContext): StepExecutionHandle {
    let logFd: number | null = null;
    const startTime = Date.now();
    const logDir = path.join(ctx.workspacePath, '.logs');
    const logFilePath = path.join(logDir, `step-${ctx.stepId}.log`);
    const workingDir = path.join(ctx.workspacePath, 'wd');

    try {
      fs.mkdirSync(logDir, { recursive: true });
      fs.mkdirSync(workingDir, { recursive: true });
      fs.chmodSync(workingDir, 0o777);

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

    let cmd: string;
    let args: string[];

    if (ctx.image) {
      cmd = 'docker';
      args = [
        'run',
        '--rm',
        '--init',
        '-v',
        `${workingDir}:/workspace`,
        '-w',
        '/workspace',
        '--entrypoint',
        'sh',
        ctx.image,
        '-c',
        ctx.command,
      ];
    } else {
      cmd = process.env.SHELL || 'sh';
      args = ['-e', '-c', ctx.command];
    }

    if (process.env.DEBUG) {
      console.log('$ ' + cmd, args.join(' '));
    }

    let child: ChildProcess;
    try {
      child = spawn(cmd, args, {
        cwd: workingDir,
        env: { ...process.env, ...ctx.env },
        detached: true,
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
          error: new Error(`Failed to spawn process: ${spawnErr.message}`),
        }),
        cancel: async () => {},
        logFilePath,
      };
    }

    let isCancelled = false;
    let timeoutTimer: NodeJS.Timeout | null = null;

    // 4. Safe Promise Resolution & Lifecycle Tracking
    const done = new Promise<StepResult>((resolve) => {
      let isResolved = false;

      const safeResolve = (result: StepResult) => {
        if (isResolved) return; // Prevent double-resolution
        isResolved = true;

        if (timeoutTimer) clearTimeout(timeoutTimer);

        try {
          fs.closeSync(logFd);
        } catch {}

        resolve(result);
      };

      // Optional step timeout
      if (ctx.timeoutMs) {
        timeoutTimer = setTimeout(() => {
          isCancelled = true;
          this.killProcessGroup(child);
        }, ctx.timeoutMs);

        // CRUCIAL: Unref timer so it doesn't hold event loop open
        timeoutTimer.unref();
      }

      child.on('close', (code) => {
        safeResolve({
          exitCode: code ?? (isCancelled ? 130 : 1),
          durationMs: Date.now() - startTime,
          error: isCancelled ? new Error('Step timed out or was cancelled by user') : undefined,
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
      this.killProcessGroup(child);
    };

    return { done, cancel, logFilePath };
  }

  /**
   * Kills the entire process group tree (-PID) with unref escalation
   */
  private killProcessGroup(child: ChildProcess) {
    if (child.pid && !child.killed) {
      try {
        // Send SIGTERM to entire process group (-PID)
        process.kill(-child.pid, 'SIGTERM');

        // Escalate to SIGKILL after 5 seconds if process tree is still alive
        const killTimer = setTimeout(() => {
          try {
            if (child.pid && !child.killed) {
              process.kill(-child.pid, 'SIGKILL');
            }
          } catch {}
        }, 5000);

        // CRUCIAL: Unref escalation timer so Node process can exit cleanly
        killTimer.unref();
      } catch {
        // Process group may already be dead
      }
    }
  }

  async readLog(file: string) {
    return readFile(file, 'utf-8');
  }
}
