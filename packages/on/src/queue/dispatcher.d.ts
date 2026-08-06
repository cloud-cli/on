export interface JobRecord {
    id: number;
    workflow_id: string;
    concurrency_key: string | null;
    status: 'pending' | 'running' | 'success' | 'failed' | 'cancelling';
    worker_id: string | null;
    payload: string;
    created_at: string;
}
export declare class QueueManager {
    private workerId;
    constructor(workerId: string);
    /**
     * Initializes the database schema.
     */
    init(): Promise<void>;
    /**
     * Enqueues a new job into the database.
     * Includes simple GitHub-style concurrency cancellation.
     */
    enqueue(workflowId: string, payload: any, concurrencyKey?: string): Promise<any>;
    /**
     * ATOMICALY claims the oldest pending job.
     * Requires SQLite >= 3.35 for the RETURNING clause.
     */
    claimNextJob(): Promise<JobRecord | null>;
    /**
     * Marks a job as completed or failed
     */
    finishJob(jobId: string | number, status: string): Promise<void>;
    /**
     * Checks if the current job has been marked for cancellation by another event
     */
    isCancelled(jobId: number): Promise<boolean>;
    clearStaleJobs(): Promise<any>;
    /**
     * Save complete execution report JSON to DB
     */
    saveReport(jobId: string | number, report: any): Promise<void>;
    /**
     * Fetch job details + report by ID
     */
    getJob(jobId: string | number): Promise<any>;
    /**
     * List recent jobs for dashboard status monitoring
     */
    listJobs(limit?: number): Promise<any[]>;
}
//# sourceMappingURL=dispatcher.d.ts.map