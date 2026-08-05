import dotenv from 'dotenv';
import fs from 'node:fs';

export class SecretStore {
  private secrets = new Map<string, string>();

  /**
   * Initialize secrets from host environment or a specified .env file
   */
  constructor(private envFilePath?: string) {}

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

  get(key: string): string | undefined {
    return this.secrets.get(key);
  }

  getAll(): Record<string, string> {
    return Object.fromEntries(this.secrets);
  }

  /**
   * Returns a list of secret values to be redacted from logs
   */
  getSecretValuesForRedaction(): string[] {
    return Array.from(this.secrets.values()).filter((v) => v.length > 3); // Avoid masking tiny strings
  }
}
