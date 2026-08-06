export declare class SecretStore {
    private envFilePath?;
    private secrets;
    /**
     * Initialize secrets from host environment or a specified .env file
     */
    constructor(envFilePath?: string | undefined);
    reload(): void;
    get(key: string): string | undefined;
    getAll(): Record<string, string>;
    /**
     * Returns a list of secret values to be redacted from logs
     */
    getSecretValuesForRedaction(): string[];
}
//# sourceMappingURL=store.d.ts.map