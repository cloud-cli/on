declare function query(method: 'get' | 'run' | 'all', statement: string, data?: Array<string | number | null>, pragma?: string[]): Promise<any>;
export declare const get: (statement: string, data?: (string | number | null)[] | undefined, pragma?: string[] | undefined) => Promise<any>;
export declare const run: (statement: string, data?: (string | number | null)[] | undefined, pragma?: string[] | undefined) => Promise<any>;
export declare const all: (statement: string, data?: (string | number | null)[] | undefined, pragma?: string[] | undefined) => Promise<any>;
export declare function pragma(p: any): void;
declare const _default: {
    query: typeof query;
    get: (statement: string, data?: (string | number | null)[] | undefined, pragma?: string[] | undefined) => Promise<any>;
    run: (statement: string, data?: (string | number | null)[] | undefined, pragma?: string[] | undefined) => Promise<any>;
    all: (statement: string, data?: (string | number | null)[] | undefined, pragma?: string[] | undefined) => Promise<any>;
    pragma: typeof pragma;
};
export default _default;
//# sourceMappingURL=db-client.d.ts.map