import dotenv from 'dotenv';
import fs from 'node:fs';
export class SecretStore {
    envFilePath;
    secrets = new Map();
    /**
     * Initialize secrets from host environment or a specified .env file
     */
    constructor(envFilePath) {
        this.envFilePath = envFilePath;
    }
    reload() {
        // 1. Load host process.env variables prefixed with SECRET_
        for (const [key, val] of Object.entries(process.env)) {
            if (key.startsWith('SECRET_') && val) {
                // Strip prefix: SECRET_SLACK_TOKEN -> SLACK_TOKEN
                this.secrets.set(key.replace('SECRET_', ''), val);
            }
        }
        // 2. Override/add from .env file if present
        if (this.envFilePath && fs.existsSync(this.envFilePath)) {
            const parsed = dotenv.parse(fs.readFileSync(this.envFilePath));
            for (const [key, val] of Object.entries(parsed)) {
                this.secrets.set(key, val);
            }
        }
    }
    get(key) {
        return this.secrets.get(key);
    }
    getAll() {
        return Object.fromEntries(this.secrets);
    }
    /**
     * Returns a list of secret values to be redacted from logs
     */
    getSecretValuesForRedaction() {
        return Array.from(this.secrets.values()).filter((v) => v.length > 3); // Avoid masking tiny strings
    }
}
//# sourceMappingURL=store.js.map