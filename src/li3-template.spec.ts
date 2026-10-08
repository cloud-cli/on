import { readdirSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

describe("LI3 template attributes", () => {
  it("does not use curly interpolation inside HTML attributes", () => {
    const templatePaths = readdirSync(resolve(process.cwd(), "src"))
      .filter((file) => file.endsWith(".html"))
      .map((file) => resolve(process.cwd(), "src", file));

    for (const path of templatePaths) {
      const template = readFileSync(path, "utf8");
      expect(template, path).not.toMatch(/\b[\w-]+="[^"\n]*\{\{/);
    }
  });
});
