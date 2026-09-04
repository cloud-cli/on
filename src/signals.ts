import { requestWorkerShutdown } from './worker.js';

export async function setupSignalHandlers(activeWorkerPromises) {
  let isShuttingDown = false;

  async function cleanupAndExit(signal: string) {
    if (isShuttingDown) return; // Prevent duplicate execution on double Ctrl+C
    isShuttingDown = true;

    console.log(`\n🛑 Received ${signal}. Initiating graceful shutdown...`);

    try {
      requestWorkerShutdown();

      if (activeWorkerPromises.length > 0) {
        console.log('⚙️ Waiting for active worker jobs to drain...');
        await Promise.allSettled(activeWorkerPromises);
      }

      console.log('✨ Engine stopped cleanly. Goodbye!');
      process.exit(0);
    } catch (err: any) {
      console.error('❌ Error during graceful shutdown:', err.message);
      process.exit(1);
    }
  }

  process.on('SIGINT', () => cleanupAndExit('SIGINT'));
  process.on('SIGTERM', () => cleanupAndExit('SIGTERM'));
  // Unlike SIGTERM from systemctl stop, this exits cleanly under Restart=always.
  process.on('SIGUSR1', () => cleanupAndExit('SIGUSR1'));
}
