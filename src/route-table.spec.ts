import { describe, expect, it } from "vitest";
import { matchRoute, routeDefinitions } from "../ui/route-table.mjs";

describe("central URLPattern route table", () => {
  it("maps static routes, aliases, and not-found paths", () => {
    expect(matchRoute("https://app.test/ui")).toMatchObject({ page: "dashboard", component: "page-dashboard" });
    expect(matchRoute("https://app.test/workspaces")).toMatchObject({
      page: "workspaces",
      component: "page-teams",
    });
    expect(matchRoute("https://app.test/ui/recipes/new")).toMatchObject({
      page: "recipe-editor",
      component: "page-recipe-editor",
      global: true,
    });
    expect(matchRoute("https://app.test/no-such-page")).toMatchObject({ page: "not-found", notFound: true });
  });

  it("maps dynamic path segments to explicit page props", () => {
    expect(matchRoute("https://app.test/workspaces/work%20space/runs")).toMatchObject({
      page: "dashboard",
      teamId: "work space",
      params: { workspaceId: "work space" },
    });
    expect(matchRoute("https://app.test/runs/42?workspaceId=space-a")).toMatchObject({
      page: "run",
      url: "/assets/pages/run.html?jobId=42",
      teamId: "space-a",
      params: { jobId: "42", workspaceId: "space-a" },
      transient: true,
    });
    expect(matchRoute("https://app.test/workspaces/team-a/invocations/invoke-1")).toMatchObject({
      page: "invocation",
      teamId: "team-a",
      params: { workspaceId: "team-a", invocationId: "invoke-1" },
    });
    expect(matchRoute("https://app.test/workspaces/%E0%A4%A/runs")).toMatchObject({
      page: "not-found",
      notFound: true,
    });
  });

  it("uses specific workspace routes before broader route shapes", () => {
    expect(matchRoute("https://app.test/workspaces/team-a/runs/events")).toMatchObject({
      page: "incoming-events",
      url: "/assets/pages/incoming-events.html?workspaceId=team-a",
      params: { workspaceId: "team-a" },
    });
    expect(matchRoute("https://app.test/workspaces/team-a/workflows/build-1?revision=4")).toMatchObject({
      page: "editor",
      teamId: "team-a",
      url: "/assets/pages/workflows.html?page=editor&id=build-1&workspaceId=team-a&revision=4",
      params: { workspaceId: "team-a", workflowId: "build-1", revision: "4" },
    });
    expect(matchRoute("https://app.test/workflows/new?workspaceId=team-a")).toMatchObject({
      page: "editor",
      teamId: "team-a",
      params: { workflowId: "new", workspaceId: "team-a" },
    });
    expect(routeDefinitions.length).toBeGreaterThan(15);
  });
});
