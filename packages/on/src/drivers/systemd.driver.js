import { spawn, exec } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { promisify } from 'node:util';
const execAsync = promisify(exec);
export class SystemdDriver {
    name = 'systemd';
    /**
     * Check if systemd bus is available on Linux host
     */
    async isSupported() {
        try {
            return fs.existsSync('/run/systemd/system');
        }
        catch {
            return false;
        }
    }
    async execute(ctx) {
        const startTime = Date.now();
        let logFd = null;
        let logFilePath = '';
        // 1. Guard Log Directory & File Handle Creation
        try {
            const logDir = path.join(ctx.workspacePath, '.logs');
            fs.mkdirSync(logDir, { recursive: true });
            logFilePath = path.join(logDir, `step-${ctx.stepId}.log`);
            logFd = fs.openSync(logFilePath, 'a');
        }
        catch (err) {
            return {
                done: Promise.resolve({
                    exitCode: 1,
                    durationMs: 0,
                    error: new Error(`Failed to initialize step log file: ${err.message}`),
                }),
                cancel: async () => { },
                logFilePath: '',
            };
        }
        // 2. Format Sanitized Systemd Unit Name
        const unitName = `workflow-${ctx.jobId}-${ctx.stepId}`.replace(/[^a-zA-Z0-9_-]/g, '_');
        // 3. Build systemd-run Flags
        const systemdFlags = [
            `--unit=${unitName}`,
            '--wait', // Block until unit completes
            '--pipe', // Stream stdio directly to file handle
            `--working-directory=${ctx.workspacePath}`,
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
        // 4. Construct Command
        let commandArgs;
        if (ctx.image) {
            commandArgs = [
                'docker',
                'run',
                '--rm',
                '--init',
                `--name=${unitName}`, // Predictable container name for stopping
                '-v',
                `${ctx.workspacePath}:/workspace`,
                '-w',
                '/workspace',
                ctx.image,
                'sh',
                '-c',
                ctx.command,
            ];
        }
        else {
            commandArgs = ['sh', '-c', ctx.command];
        }
        // 5. Spawn systemd-run
        let child;
        try {
            child = spawn('systemd-run', [...systemdFlags, '--', ...commandArgs], {
                stdio: ['ignore', logFd, logFd],
            });
        }
        catch (spawnErr) {
            try {
                if (logFd !== null)
                    fs.closeSync(logFd);
            }
            catch { }
            return {
                done: Promise.resolve({
                    exitCode: 1,
                    durationMs: Date.now() - startTime,
                    error: new Error(`Failed to spawn systemd-run: ${spawnErr.message}`),
                }),
                cancel: async () => { },
                logFilePath,
            };
        }
        let isCancelled = false;
        // 6. Safe Promise Resolution & File Handle Cleanup
        const done = new Promise((resolve) => {
            let isResolved = false;
            const safeResolve = (result) => {
                if (isResolved)
                    return; // Prevent double-resolution
                isResolved = true;
                try {
                    if (logFd !== null)
                        fs.closeSync(logFd);
                }
                catch { }
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
        // 7. Systemd / Docker Graceful Cancellation
        const cancel = async () => {
            isCancelled = true;
            try {
                if (ctx.image) {
                    // Stop docker container gracefully if running
                    await execAsync(`docker stop -t 2 ${unitName}`).catch(() => { });
                }
                // Stop systemd transient unit (sends SIGTERM -> SIGKILL to Cgroup tree)
                await execAsync(`systemctl stop ${unitName}.service`).catch(() => { });
            }
            catch {
                // Unit or container may already be stopped
            }
        };
        return { done, cancel, logFilePath };
    }
}
//# sourceMappingURL=systemd.driver.js.map