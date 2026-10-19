import { describe, expect, it } from "vitest";
import { SecretStore } from "./secrets.js";

describe("SecretStore log redaction", () => {
  it("redacts short, JSON-escaped, and base64 secret forms", () => {
    const secrets = new SecretStore();
    secrets.replace({ SHORT: "x" });
    expect(secrets.redactText("x")).toBe("****");

    secrets.replace({
      JSON_VALUE: 'secret"value',
      BINARY: { value: Buffer.from("binary-secret").toString("base64"), encoding: "base64" },
    });
    expect(secrets.redactText('secret"value')).toBe("****");
    expect(secrets.redactText('secret\\"value')).toBe("****");
    expect(secrets.redactText("YmluYXJ5LXNlY3JldA== binary-secret")).toBe("**** ****");
  });
});
