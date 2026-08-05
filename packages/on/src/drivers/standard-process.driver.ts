import { spawn, ChildProcess } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { ExecutionDriver, StepContext, StepExecutionHandle, StepResult } from '../types.js';

export class StandardProcessDriver implements ExecutionDriver {
  name = 'standard-process';

  async isSupported(): Promise<boolean> {
    return true; // Supported everywhere
  }

  async execute(ctx: StepContext): Promise<StepExecutionHandle> {
    const startTime = Date.now();

    // 1. Prepare Log Directory and Log File Descriptor
    const logDir = path.join(ctx.workspacePath, '.logs');
    fs.mkdirSync(logDir, { recursive: true });
    const logFilePath = path.join(logDir, `step-${ctx.stepId}.log`);

    // Open file in append mode to get a raw OS kernel file descriptor
    const logFd = fs.openSync(logFilePath, 'a');

    // 2. Format Execution Command
    let cmd: string;
    let args: string[];

    if (ctx.image) {
      // Run inside Docker
      cmd = 'docker';
      args = [
        'run', '--rm', '--init',
        '-v', `${ctx.workspacePath}:/workspace`,
        '-w', '/workspace',
        ctx.image,
        'sh', '-c', ctx.command
      ];
    } else {
      // Run on Host Shell
      cmd = 'sh';
      args = ['-c', ctx.command];
    }

    // 3. Spawn Detached Process (Creates a new Process Group)
    const child = spawn(cmd, args, {
      cwd: ctx.workspacePath,
      env: { ...process.env, ...ctx.env },
      detached: true, // Crucial for process group killing
      stdio: [
        'ignore', // stdin
        logFd,    // stdout -> Direct to OS file descriptor
        logFd     // stderr -> Direct to OS file descriptor
      ]
    });

    let isCancelled = false;

    // 4. Handle Process Exit as a Promise
    const done = new Promise<StepResult>((resolve) => {
      let timeoutTimer: NodeJS.Timeout | null = null;

      if (ctx.timeoutMs) {
        timeoutTimer = setTimeout(() => {
          this.killProcessGroup(child);
        }, ctx.timeoutMs);
      }

      child.on('close', (code) => {
        if (timeoutTimer) clearTimeout(timeoutTimer);
        // Safely close the log file descriptor
        try { fs.closeSync(logFd); } catch {}

        resolve({
          exitCode: code ?? (isCancelled ? 130 : 1),
          durationMs: Date.now() - startTime,
          error: isCancelled ? new Error('Step cancelled by user') : undefined
        });
      });

      child.on('error', (err) => {
        if (timeoutTimer) clearTimeout(timeoutTimer);
        try { fs.closeSync(logFd); } catch {}

        resolve({
          exitCode: 1,
          durationMs: Date.now() - startTime,
          error: err
        });
      });
    });

    // 5. Cancellation Hook
    const cancel = async (): Promise<void> => {
      isCancelled = true;
      this.killProcessGroup(child);
    };

    return { done, cancel, logFilePath };
  }

  /**
   * Kills the entire process group tree (negative PID)
   */
  private killProcessGroup(child: ChildProcess) {
    if (child.pid && !child.killed) {
      try {
        // -PID kills all subprocesses spawned under this group
        process.kill(-child.pid, 'SIGTERM');

        // Escalation to SIGKILL after 5 seconds if still alive
        setTimeout(() => {
          try { process.kill(-child.pid!, 'SIGKILL'); } catch {}
        }, 5000);
      } catch {
        // Process might already be dead
      }
    }
  }
}