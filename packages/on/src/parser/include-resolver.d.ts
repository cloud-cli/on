export declare class WorkflowIncludeResolver {
    private baseDir;
    private maxDepth;
    constructor(baseDir: string, maxDepth?: number);
    /**
     * Recursively loads and merges YAML workflows while guarding against cycles.
     */
    resolve(filePath: string, visited?: Set<string>, depth?: number): any;
}
//# sourceMappingURL=include-resolver.d.ts.map