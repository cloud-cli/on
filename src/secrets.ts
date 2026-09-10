
import type { StoredSecret } from './secret-repository.js';

export class SecretStore {
  private secrets = new Map<string, StoredSecret>();

  /** Holds job-scoped secrets supplied by the control plane. */
  constructor() {
    this.reload();
  }

  reload() {
  }

  get(key: string): string | undefined {
    return this.secrets.get(key)?.value;
  }

  getValue(key: string): StoredSecret | undefined {
    return this.secrets.get(key);
  }

  getAll(): Record<string, string> {
    return Object.fromEntries([...this.secrets].map(([key, value]) => [key, value.value]));
  }

  replace(values: Record<string, string | StoredSecret>) {
    this.secrets = new Map(Object.entries(values).map(([key, value]) => [key, typeof value === 'string' ? { value, encoding: 'utf8' } : value]));
  }

  redactText(text: string) {
    // Avoid masking tiny strings
    const secrets: string[] = Array.from(this.secrets.values()).map((v) => v.value).filter((v) => v.length > 3);

    // Sort longest secrets first to prevent partial replacements
    const ordered = secrets.slice().sort((a, b) => b.length - a.length);

    for (const secret of ordered) {
      text = text.replaceAll(secret, '****');
    }

    return text;
  }
}
