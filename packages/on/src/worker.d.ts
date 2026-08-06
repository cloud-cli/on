import { QueueManager } from './queue/dispatcher.js';
import { SecretStore } from './secrets/store.js';
import { RunnerConfig } from './config.js';
export declare function startWorkers(count: number, queue: QueueManager, secrets: SecretStore, config: RunnerConfig): Promise<void>[];
/**
 * Main worker loop: continuously polls the SQLite queue for pending jobs.
 */
export declare function startWorkerLoop(workerId: string, queue: QueueManager, secrets: SecretStore, config: RunnerConfig): Promise<void>;
//# sourceMappingURL=worker.d.ts.map