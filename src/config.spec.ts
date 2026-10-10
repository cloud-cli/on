import { afterEach, describe, expect, it, vi } from "vitest";
import { loadConfig, resolveConfig } from "./config.js";

describe("OIDC configuration", () => {
  afterEach(() => vi.unstubAllEnvs());

  it("loads OIDC settings from environment variables", () => {
    vi.stubEnv("OIDC_ISSUER", "https://auth.test");
    vi.stubEnv("RUNNER_OIDC_CLIENT_ID", "runner");
    vi.stubEnv("RUNNER_OIDC_CLIENT_SECRET", "secret");

    expect(resolveConfig({}, {}).oidc).toEqual({
      providerUrl: "https://auth.test",
      clientId: "runner",
      clientSecret: "secret",
    });
  });

  it("uses DATABASE_URL for the database module and CLI values take precedence", () => {
    vi.stubEnv("DATABASE_URL", "file:///env/database.mjs");

    expect(resolveConfig({}, {}).database).toBe("file:///env/database.mjs");
    expect(resolveConfig({}, { database: "file:///cli/database.mjs" }).database).toBe("file:///cli/database.mjs");
  });

  it("prefers file OIDC settings over environment variables", () => {
    vi.stubEnv("RUNNER_OIDC_PROVIDER_URL", "https://env.test");
    vi.stubEnv("RUNNER_OIDC_CLIENT_ID", "env-client");
    vi.stubEnv("RUNNER_OIDC_CLIENT_SECRET", "env-secret");
    const oidc = { providerUrl: "https://file.test", clientId: "file-client", clientSecret: "file-secret" };

    expect(resolveConfig({ oidc }, {}).oidc).toEqual(oidc);
  });

  it("accepts the standard OIDC issuer and client environment variable names", () => {
    vi.stubEnv("OIDC_ISSUER", "https://auth.test");
    vi.stubEnv("OIDC_CLIENT_ID", "runner");
    vi.stubEnv("OIDC_CLIENT_SECRET", "secret");

    expect(resolveConfig({}, {}).oidc).toEqual({
      providerUrl: "https://auth.test",
      clientId: "runner",
      clientSecret: "secret",
    });
  });

  it("prefers OIDC_ISSUER over the legacy runner-prefixed issuer variable", () => {
    vi.stubEnv("OIDC_ISSUER", "https://issuer.test");
    vi.stubEnv("RUNNER_OIDC_PROVIDER_URL", "https://legacy.test");
    vi.stubEnv("OIDC_CLIENT_ID", "runner");
    vi.stubEnv("OIDC_CLIENT_SECRET", "secret");

    expect(resolveConfig({}, {}).oidc?.providerUrl).toBe("https://issuer.test");
  });
});

describe("beta deployment configuration", () => {
  afterEach(() => vi.unstubAllEnvs());

  it.each(["true", "TRUE", "1", "yes"])("enables beta mode for %s", (value) => {
    vi.stubEnv("BETA", value);

    expect(resolveConfig({}, {}).beta).toBe(true);
  });

  it.each([undefined, "", "false", "0", "no"])("keeps production mode for %s", (value) => {
    vi.stubEnv("BETA", value ?? "");

    expect(resolveConfig({}, {}).beta).toBe(false);
  });
});

describe("API-only worker configuration", () => {
  afterEach(() => vi.unstubAllEnvs());

  it("loads start-workers configuration without DATABASE_URL", async () => {
    vi.stubEnv("DATABASE_URL", "");
    const config = await loadConfig({ command: "start-workers", config: "/tmp/runner-config-does-not-exist.mjs" });
    expect(config?.database).toBe("");
  });
});
