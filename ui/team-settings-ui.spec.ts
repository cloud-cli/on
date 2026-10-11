import { describe, expect, it, vi } from "vitest";
import { generateTeamSettingsHtml } from "./team-settings-ui.js";
import setup from "./team-settings-ui.mjs?raw";
import { WebhookServer } from "../src/server.js";

describe("team settings UI", () => {
  it("provides workspace-specific settings and management actions", () => {
    const html = generateTeamSettingsHtml();

    expect(html).toContain("{{ teamName }} workspace");
    expect(html).toContain("Create invite link");
    expect(html).toContain("Create webhook");
    expect(html).toContain('for="member of members"');
    expect(html).toContain('class-hidden="!isAdmin"');
    expect(html).toContain('script setup src="/team-settings-ui.mjs"');
  });

  it("loads and mutates only the team identified by the route", () => {
    expect(setup).toContain('location.pathname.split("/")[2]');
    expect(setup).toContain("request(`/api/v1/workspaces/${encodeURIComponent(teamId)}/members`)");
    expect(setup).toContain("request(`/api/v1/workspaces/${encodeURIComponent(teamId)}/invitations`");
    expect(setup).toContain("request(`/api/v1/workspaces/${encodeURIComponent(teamId)}/webhooks`");
    expect(setup).toContain('"X-Team-ID": teamId');
    expect(setup).toContain("You are not a member of this workspace.");
  });
  it("keeps team settings focused on the selected team", () => {
    expect(generateTeamSettingsHtml()).toContain("Workspace members share workflows");
    expect(setup).not.toContain('request("/api/v1/teams",');
  });

  it("shows team and shared runner management with admin-only mutations", () => {
    const html = generateTeamSettingsHtml();
    expect(html).toContain("Workspace-scoped runners");
    expect(html).toContain("Active shared runners");
    expect(html).toContain("Available shared runners");
    expect(html).toContain("One-time enrollment code");
    expect(html).toContain('class-hidden="!isAdmin"');
    expect(html).not.toContain("Update runner");
    expect(setup).toContain('JSON.stringify({ scope: "team", teamId })');
    expect(setup).toContain('method: active ? "POST" : "DELETE"');
    expect(setup).toContain("/api/v1/teams/${encodeURIComponent(teamId)}/runners");
  });
  it("offers team selection links from the landing UI", async () => {
    const { readFileSync } = await import("node:fs");
    const html = readFileSync(new URL("../src/teams-landing.html", import.meta.url), "utf8");
    const landing = readFileSync(new URL("../src/teams-landing.mjs", import.meta.url), "utf8");
    expect(html).toContain("Choose a workspace");

    expect(html).toContain("encodeURIComponent(team.id) + '/settings'");
    expect(landing).toContain('apiFetch("/api/v1/workspaces"');
  });

  it("extracts app content from Prettier-formatted template tags", () => {
    const response = { writeHead: vi.fn().mockReturnThis(), end: vi.fn() };
    const source = `<html><template app
      ><main><h1>Team settings</h1><template if="visible"><p>Nested</p></template></main><script setup></script></template></html>`;

    (WebhookServer.prototype as any).renderPageComponent.call({}, response, "page-team-settings", source);

    const rendered = response.end.mock.calls[0][0];
    expect(rendered).toContain('<template component="page-team-settings">');
    expect(rendered).toContain("<main><h1>Team settings</h1>");
    expect(rendered).not.toContain("<html>");
  });
});
