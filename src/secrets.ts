import type { StoredSecret } from "./secret-repository.js";

export class SecretStore {
  private secrets = new Map<string, StoredSecret>();
  private additionalRedactionValues = new Set<string>();

  /** Holds job-scoped secrets supplied by the control plane. */
  constructor() {
    this.reload();
  }

  reload() {}

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
    this.additionalRedactionValues.clear();
    this.secrets = new Map(
      Object.entries(values).map(([key, value]) => [
        key,
        typeof value === "string" ? { value, encoding: "utf8" } : value,
      ]),
    );
  }

  addRedactionValue(value: string): void {
    if (value) {
      this.additionalRedactionValues.add(value);
    }
  }

  redactText(text: string) {
    // Mask the configured representation and common byte encodings. Base64
    // secrets are passed to job processes as base64 but may be decoded before
    // being printed.
    const secrets = [
      ...Array.from(this.secrets.values()).flatMap((secret) => {
        const variants = [secret.value];
        if (secret.encoding === "base64") {
          variants.push(Buffer.from(secret.value, "base64").toString("utf8"));
        } else {
          variants.push(Buffer.from(secret.value, "utf8").toString("base64"));
        }
        return variants
          .flatMap((value) => [value, JSON.stringify(value).slice(1, -1)])
          .filter((value) => value.length > 0);
      }),
      ...this.additionalRedactionValues,
    ];

    // Sort longest secrets first to prevent partial replacements
    const ordered = secrets.slice().sort((a, b) => b.length - a.length);

    for (const secret of ordered) {
      text = text.replaceAll(secret, "****");
    }

    return text;
  }
}
