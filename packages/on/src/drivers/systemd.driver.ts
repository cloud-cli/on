import { spawn, exec } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { promisify } from 'node:util';
import { ExecutionDriver, StepContext, StepExecutionHandle, StepResult } from '../types.js';

const execAsync = promisify(exec);

export class SystemdDriver implements ExecutionDriver {
  name = 'systemd';

  /**
   * Check if host machine is running systemd
   */
  async isSupported(): Promise<boolean> {
    try {
      // /run/systemd/system is created by systemd PID 1 on boot
      return fs.existsSync('/run/systemd/system');
    } catch {
      return false;
    }
  }

  async execute(ctx: StepContext): Promise<StepExecutionHandle> {
    const startTime = Date.now();

    // 1. Sanitize unit name for systemd (e.g. job-001-step-build)
    const unitName = `workflow-${ctx.jobId}-${ctx.stepId}`.replace(/[^a-zA-Z0-9_-]/g, '_');

    // 2. Prepare Log File Descriptor
    const logDir = path.join(ctx.workspacePath, '.logs');
    fs.mkdirSync(logDir, { recursive: true });
    const logFilePath = path.join(logDir, `step-${ctx.stepId}.log`);
    const logFd = fs.openSync(logFilePath, 'a');

    // 3. Build systemd-run flags
    const systemdFlags: string[] = [
      `--unit=${unitName}`,
      '--wait',                             // Block until unit completes
      '--pipe',                             // Stream stdio directly
      `--working-directory=${ctx.workspacePath}`
    ];

    // Inject Environment Variables into systemd unit
    if (ctx.env) {
      for (const [key, val] of Object.entries(ctx.env)) {
        systemdFlags.push(`--setenv=${key}=${val}`);
      }
    }

    // Apply memory/timeout limits if provided
    if (ctx.timeoutMs) {
      const timeoutSec = Math.ceil(ctx.timeoutMs / 1000);
      systemdFlags.push(`--property=RuntimeMaxSec=${timeoutSec}`);
    }

    // 4. Construct Command (Host Shell vs Docker)
    let commandArgs: string[];

    if (ctx.image) {
      commandArgs = [
        'docker', 'run', '--rm', '--init',
        `--name=${unitName}`,               // Match docker container name for easy cancellation
        '-v', `${ctx.workspacePath}:/workspace`,
        '-w', '/workspace',
        ctx.image,
        'sh', '-c', ctx.command
      ];
    } else {
      commandArgs = ['sh', '-c', ctx.command];
    }

    // 5. Spawn systemd-run
    const child = spawn('systemd-run', [...systemdFlags, '--', ...commandArgs], {
      stdio: [
        'ignore', // stdin
        logFd,    // stdout -> OS File Descriptor
        logFd     // stderr -> OS File Descriptor
      ]
    });

    let isCancelled = false;

    // 6. Handle Process Completion
    const done = new Promise<StepResult>((resolve) => {
      child.on('close', (code) => {
        try { fs.closeSync(logFd); } catch {}

        resolve({
          exitCode: code ?? (isCancelled ? 130 : 1),
          durationMs: Date.now() - startTime,
          error: isCancelled ? new Error('Step cancelled by user/systemd') : undefined
        });
      });

      child.on('error', (err) => {
        try { fs.closeSync(logFd); } catch {}

        resolve({
          exitCode: 1,
          durationMs: Date.now() - startTime,
          error: err
        });
      });
    });

    // 7. Systemd-Native Cancellation
    const cancel = async (): Promise<void> => {
      isCancelled = true;

      try {
        // If Docker was running, stop container gracefully first
        if (ctx.image) {
          await execAsync(`docker stop -t 2 ${unitName}`).catch(() => {});
        }

        // Stop the transient unit (sends SIGTERM, then SIGKILL to entire cgroup)
        await execAsync(`systemctl stop ${unitName}.service`).catch(() => {});
      } catch {
        // Unit might already be dead
      }
    };

    return { done, cancel, logFilePath };
  }
}