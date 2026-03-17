import { defineConfig } from "vitest/config";

export default function (_projectRoot: string) {
  return defineConfig({
    test: {
      globals: true,
      environment: "node",
      include: ["src/**/*.spec.ts"],
      coverage: {
        provider: "istanbul",
        reporter: ["text", "lcov"],
      },
    },
  });
}
