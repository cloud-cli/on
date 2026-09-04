
export class SecretStore {
  private secrets = new Map<string, string>();

  /** Holds job-scoped secrets supplied by the control plane. */
  constructor() {
    this.reload();
  }

  reload() {
  }

  get(key: string): string | undefined {
    return this.secrets.get(key);
  }

  getAll(): Record<string, string> {
    return Object.fromEntries(this.secrets);
  }

  replace(values: Record<string, string>) {
    this.secrets = new Map(Object.entries(values));
  }

  redactText(text: string) {
    // Avoid masking tiny strings
    const secrets: string[] = Array.from(this.secrets.values()).filter((v) => v.length > 3);

    // Sort longest secrets first to prevent partial replacements
    const ordered = secrets.slice().sort((a, b) => b.length - a.length);

    for (const secret of ordered) {
      text = text.replaceAll(secret, '****');
    }

    return text;
  }
}
