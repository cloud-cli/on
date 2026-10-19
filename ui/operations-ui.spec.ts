import { describe, expect, it } from "vitest";
import { generateOperationsHtml } from "./operations-ui.js";
import setup from "./operations-ui.mjs?raw";
import server from "../src/server.ts?raw";
import router from "./app-router.mjs?raw";

describe("global operations page", () => {
  it("offers global worker, runner, and OIDC role controls without secrets management", () => {
    const html = generateOperationsHtml();
    expect(html).toContain("Worker presence");
    expect(html).toContain("Runners");
    expect(html).toContain("People");
    expect(html).toContain("System users");
    expect(html).toContain("Automation tokens");
    expect(setup).toContain("/api/v1/workers");
    expect(setup).toContain("/api/v1/runner-enrollments");
    expect(setup).toContain("/api/v1/runners/");
    expect(setup).toContain("/api/v1/system-users");
    expect(setup).not.toMatch(/api-keys|secrets/);
  });

  it("uses an admin-guarded route and is discoverable by the app router", () => {
    expect(server).toContain('url.pathname === "/operations"');
    expect(server).toContain('url.pathname === "/pages/operations.html"');
    expect(router).toContain('path === "/operations"');
    expect(server).toContain('"platform.users.view"');
    expect(server).toContain('"platform.runners.view"');
  });
});
