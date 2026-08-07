import { existsSync, readFileSync } from 'node:fs';
import { parseEnv } from 'node:util';

export class SecretStore {
  private secrets = new Map<string, string>();

  /**
   * Initialize secrets from host environment or a specified .env file
   */
  constructor(private envFilePath?: string) {
    this.reload();
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
    if (this.envFilePath && existsSync(this.envFilePath)) {
      console.log('Found .env at ' + this.envFilePath);
      const parsed = parseEnv(readFileSync(this.envFilePath, 'utf8'));

      for (const [key, val] of Object.entries(parsed)) {
        this.secrets.set(key, val || '');
      }
    }
  }

  get(key: string): string | undefined {
    return this.secrets.get(key);
  }

  getAll(): Record<string, string> {
    return Object.fromEntries(this.secrets);
  }

  redactText(text: string) {
    // Avoid masking tiny strings
    const secrets: string[] = Array.from(this.secrets.values()).filter((v) => v.length > 3);

    // Sort longest secrets first to prevent partial replacements
    const ordered = secrets.slice().sort((a, b) => b.length - a.length);

    for (const secret of ordered) {
      text = text.replaceAll(secret, '** masked **');
    }
  }
}
