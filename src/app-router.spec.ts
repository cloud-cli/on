import { describe, expect, it } from "vitest";
import routerTemplate from "../ui/app-router.html?raw";
import routerSetup from "../ui/app-router.mjs?raw";
import serverSetup from "./server.ts?raw";

describe("LI3 app router", () => {
  it("uses route table matching and passes props before mounting route components", () => {
    expect(routerSetup).toContain('import { matchRoute } from "@app/route-table.mjs"');
    expect(routerSetup).toContain("const route = () => matchRoute(window.location.href)");
    expect(routerSetup).toContain("component.routeParams = Object.freeze");
    expect(routerSetup).toContain("outlet.value.append(component)");
  });

  it("renders transient loading, onboarding, not-found, and error UI through template bindings", () => {
    for (const view of ["loading", "onboarding", "not-found", "error"]) {
      expect(routerTemplate).toContain(`transientView === '${view}'`);
    }
    expect(routerTemplate).toContain("{{ routeError }}");
    expect(routerTemplate).toContain('on-submit="createWorkspace($event)"');
    expect(routerTemplate).toContain('on-click="retryNavigation()"');
    expect(routerSetup).not.toContain('document.createElement("main")');
    expect(routerSetup).not.toContain(".innerHTML");
    expect(routerSetup).not.toContain(".textContent =");
  });

  it("preserves navigation interception and lifecycle cleanup", () => {
    expect(routerSetup).toContain('document.addEventListener("click", handleClick)');
    expect(routerSetup).toContain('document.removeEventListener("click", handleClick)');
    expect(routerSetup).toContain('window.addEventListener("popstate", handlePopState)');
    expect(routerSetup).toContain('target.pathname.startsWith("/auth/")');
    expect(routerSetup).toContain('target.pathname.startsWith("/api/v1/")');
  });

  it("keeps shell deep-link delivery for workspace route paths", () => {
    expect(serverSetup).toContain("return this.renderAppShell(res);");
    expect(serverSetup).toContain("/workspaces");
    expect(routerTemplate).toContain('ref="outlet"');
  });
});
