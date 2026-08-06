export interface MatrixStrategy {
    matrix?: Record<string, (string | number | boolean)[]>;
    'max-parallel'?: number;
}
export interface ParsedWorkflow {
    id?: string;
    name: string;
    strategy?: MatrixStrategy;
    env?: Record<string, string>;
    steps: any[];
    [key: string]: any;
}
/**
 * Expands a workflow definition containing a `strategy.matrix` into dynamic single-instance workflow jobs.
 */
export declare function expandMatrix(workflow: ParsedWorkflow): ParsedWorkflow[];
//# sourceMappingURL=matrix-expander.d.ts.map