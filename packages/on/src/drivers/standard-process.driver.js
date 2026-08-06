import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
export class StandardProcessDriver {
    name = 'standard-process';
    async isSupported() {
        return true; // Supported on all OS platforms
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
        // 2. Format Execution Command
        let cmd;
        let args;
        if (ctx.image) {
            cmd = 'docker';
            args = [
                'run',
                '--rm',
                '--init',
                '-v',
                `${ctx.workspacePath}:/workspace`,
                '-w',
                '/workspace',
                '--entrypoint',
                'sh',
                ctx.image,
                '-c',
                ctx.command,
            ];
        }
        else {
            cmd = 'sh';
            args = ['-c', ctx.command];
        }
        // 3. Spawn Detached Child Process
        let child;
        try {
            child = spawn(cmd, args, {
                cwd: ctx.workspacePath,
                env: { ...process.env, ...ctx.env },
                detached: true, // Creates separate Process Group ID
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
                    error: new Error(`Failed to spawn process: ${spawnErr.message}`),
                }),
                cancel: async () => { },
                logFilePath,
            };
        }
        let isCancelled = false;
        let timeoutTimer = null;
        // 4. Safe Promise Resolution & Lifecycle Tracking
        const done = new Promise((resolve) => {
            let isResolved = false;
            const safeResolve = (result) => {
                if (isResolved)
                    return; // Prevent double-resolution
                isResolved = true;
                if (timeoutTimer)
                    clearTimeout(timeoutTimer);
                // Always close log File Descriptor safely
                try {
                    if (logFd !== null)
                        fs.closeSync(logFd);
                }
                catch { }
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
        // 5. Cancellation Hook
        const cancel = async () => {
            isCancelled = true;
            this.killProcessGroup(child);
        };
        return { done, cancel, logFilePath };
    }
    /**
     * Kills the entire process group tree (-PID) with unref escalation
     */
    killProcessGroup(child) {
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
                    }
                    catch { }
                }, 5000);
                // CRUCIAL: Unref escalation timer so Node process can exit cleanly
                killTimer.unref();
            }
            catch {
                // Process group may already be dead
            }
        }
    }
}
//# sourceMappingURL=standard-process.driver.js.map