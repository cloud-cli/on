import { afterEach, describe, expect, it } from "vitest";
import { SecretRepository } from "./secret-repository.js";

describe("SecretRepository isolated encryption", () => {
  const previousKey = process.env.RUNNER_MASTER_KEY;

  afterEach(() => {
    if (previousKey === undefined) {delete process.env.RUNNER_MASTER_KEY;}
    else {process.env.RUNNER_MASTER_KEY = previousKey;}
  });

  it("encrypts and decrypts isolated webhook secrets without exposing plaintext", () => {
    process.env.RUNNER_MASTER_KEY = "test-only-master-key";
    const repository = new SecretRepository();
    const ciphertext = repository.encryptValue("webhook-signing-secret");

    expect(ciphertext).not.toContain("webhook-signing-secret");
    expect(repository.decryptValue(ciphertext)).toBe("webhook-signing-secret");
    expect(() => repository.decryptValue(`${ciphertext.slice(0, -4)}AAAA`)).toThrow();
  });
});
