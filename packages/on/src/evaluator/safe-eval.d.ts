export declare const BUILTIN_HELPERS: Record<string, any>;
export declare class SafeExpressionEvaluator {
    /**
     * Deterministic Value Evaluator (Used for `env:`, `name:`, `image:`, `concurrency:`)
     * - Native non-string types (booleans, numbers, objects) pass through untouched.
     * - Strings WITHOUT `${` are returned as 100% literal strings (zero JS AST overhead).
     * - Strings WITH `${` are evaluated strictly as ES Template Literals.
     */
    static evaluateValue(val: any, context?: Record<string, any>): Promise<any>;
    /**
     * Deterministic Condition Evaluator (Used for `if:`)
     * Strictly parses code as a JavaScript expression and coerces result to boolean.
     * Throws an explicit AST Parse Error on invalid syntax (fails fast and loud).
     */
    static evaluateCondition(code: string, context?: Record<string, any>): Promise<boolean>;
    /**
     * Evaluates direct JS code (Used for `eval:` steps or internal expression resolution).
     */
    static evaluateExpression(code: string, context?: Record<string, any>): Promise<any>;
    /**
     * Alias wrapper for backward compatibility with step runners
     */
    static evaluateAsync(code: string, context?: Record<string, any>): Promise<any>;
    /**
     * Asynchronous AST Node Walker with Security Guards
     */
    private static evalNodeAsync;
}
//# sourceMappingURL=safe-eval.d.ts.map