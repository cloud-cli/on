import { describe, expect, it, vi } from "vitest";
import { generateTeamSettingsHtml } from "./team-settings-ui.js";
import { generateSettingsHtml } from "./settings-ui.js";
import setup from "./team-settings-ui.mjs?raw";
import { workspaceIdFromPathname } from "./workspace-path.mjs";
import { WebhookServer } from "../src/server.js";

describe("team settings UI", () => {
  it("provides workspace-specific settings and management actions", () => {
    const html = generateTeamSettingsHtml();

    expect(html).toContain("{{ teamName }} workspace");
    expect(html).toContain("Get link");
    expect(html).toContain("Invite by OIDC subject");
    expect(html).toContain('aria-label="OIDC subject"');
    expect(html).toContain("member.kind === 'agent' ? 'Agent' : 'Person'");
    expect(html).toContain("Create webhook");
    expect(html).toContain("Webhook URL slug.");
    expect(html).toContain('for="member of members"');
    expect(html).toContain('class-hidden="!isAdmin"');
    expect(html).toContain('script setup src="/assets/team-settings-ui.mjs"');
    expect(html).not.toContain("Personal settings</a>");
    expect(html.match(/rounded-xl border border-app-border bg-app-card p-5/g)).toHaveLength(5);
    expect(html).toContain('aria-label="Workspace settings sections"');
    expect(html).toContain(
      'class="sticky top-0 z-10 flex flex-wrap items-center justify-between gap-3 border-b border-app-border bg-app-background py-2"',
    );
    expect(
      html.match(/rounded-md border border-app-border bg-white px-2\.5 py-1\.5 text-xs font-medium/g),
    ).toHaveLength(6);
    expect(html).toContain('href="#team-members"');
    expect(html).toContain('href="#team-webhooks"');
    expect(html).toContain('href="#team-runners"');
    expect(html).toContain('href="#workspace-permissions"');
    expect(html).toContain('href="#workspace-secrets"');
    expect(html).toContain('<h2 id="team-runners-title" class="text-lg font-semibold">Task Runners</h2>');
    expect(html).toContain('<h2 id="workspace-secrets-title" class="text-lg font-semibold">Task Runner Secrets</h2>');
    expect(html).toContain("bg-app-warning/10");
    expect(html).toContain("text-app-warning");
    expect(html).not.toContain('value="github"');
    expect(html).toContain('on-change="setFileMode($event)"');
    expect(html).toContain('on-input="setWebhookProvider($event)"');
    expect(setup).toContain("webhookProvider.value = event.target.value");
    expect(setup).toContain("const provider = webhookProvider.value.trim()");
    expect(setup).toContain("JSON.stringify({ provider })");
    expect(setup).toContain("/^[a-z0-9-]+$/.test(provider)");
    expect(html).not.toContain('on-input="webhookProvider = $event.target.value"');
    expect(html).not.toContain("fileMode = $event.target.checked");
    expect(setup).toContain("const setFileMode = (event) =>");
    expect(setup).toContain("fileMode.value = event.target.checked");
    expect(setup).toMatch(/return\s*\{[\s\S]*\bsetFileMode\b/);
    expect(html).not.toContain("max-w-6xl");
    expect(html).not.toContain("mx-auto");
    expect(html).toContain('class="w-full space-y-5 py-2"');
  });

  it("places invitation entry after members and permissions", () => {
    const html = generateTeamSettingsHtml();
    const members = html.indexOf('id="team-members"');
    const invitationForm = html.indexOf('on-submit.prevent="createInvitation()"');
    const invitationSection = html.lastIndexOf('class="mt-6 border-t border-app-border pt-5"', invitationForm);
    const webhooks = html.indexOf('id="team-webhooks"');
    const secrets = html.indexOf('id="workspace-secrets"');
    const tokens = html.indexOf('id="workspace-tokens"');
    const permissions = html.indexOf('id="workspace-permissions"');

    expect(invitationForm).toBeGreaterThan(members);
    expect(invitationForm).toBeLessThan(webhooks);
    expect(invitationSection).toBeGreaterThan(members);
    expect(html.slice(invitationSection, webhooks)).toContain('class="mt-3 flex gap-2"');
    expect(html.slice(invitationSection, webhooks)).toContain("Get link");
    expect(secrets).toBeGreaterThan(webhooks);
    expect(permissions).toBeGreaterThan(secrets);
    expect(tokens).toBe(-1);
  });

  it("puts webhooks in their own section after workspace members", () => {
    const html = generateTeamSettingsHtml();
    const membersSection = html.indexOf('id="team-members"');
    const webhooksSection = html.indexOf('id="team-webhooks"');
    const runnersSection = html.indexOf('id="team-runners"');

    expect(membersSection).toBeGreaterThan(-1);
    expect(webhooksSection).toBeGreaterThan(membersSection);
    expect(runnersSection).toBeGreaterThan(webhooksSection);
    expect(html.slice(membersSection, webhooksSection)).not.toContain("createWebhook()");
    expect(html.slice(webhooksSection, runnersSection)).toContain("createWebhook()");
  });

  it("loads and mutates only the team identified by the route", () => {
    expect(setup).toContain("workspaceIdFromPathname(location.pathname)");
    expect(setup).not.toContain('location.pathname.split("/")[2]');
    expect(setup).toContain('workspaceUrl("/permissions")');
    expect(setup).toContain('workspaceUrl("/invitations")');
    expect(setup).toContain("JSON.stringify({ subject })");
    expect(setup).toContain("createSubjectInvitation");
    expect(setup).toContain('workspaceUrl("/webhooks")');
    expect(setup).toContain('"X-Team-ID": teamId');
    expect(setup).toContain("You are not a member of this workspace.");
  });

  it.each([
    ["/ui/workspaces/team-a/settings", "team-a"],
    ["/ui/teams/team-b/settings", "team-b"],
    ["/workspaces/team%2Da/settings", "team-a"],
    ["/ui/workspaces/team-a/runs", ""],
  ])("extracts the workspace id from %s", (pathname, expected) => {
    expect(workspaceIdFromPathname(pathname)).toBe(expected);
  });
  it("keeps team settings focused on the selected team", () => {
    expect(generateTeamSettingsHtml()).toContain("Workspace members");
    expect(setup).not.toContain('request("/api/v1/teams",');
  });

  it("manages workspace secrets and permissions without principal tokens", () => {
    const html = generateTeamSettingsHtml();
    expect(html).not.toContain("Agents &amp; tokens");
    expect(html).toContain("Task Runner Secrets");
    expect(setup).toContain("/api/v1/secrets/");
    expect(setup).toContain('"X-Team-ID": teamId');
    expect(setup).not.toMatch(/system-users|tokens/);
    expect(generateSettingsHtml()).not.toContain("Agents &amp; tokens");
    expect(generateSettingsHtml()).not.toContain("Secrets");
  });

  it("shows team and shared runner management with admin-only mutations", () => {
    const html = generateTeamSettingsHtml();
    expect(html).toContain("Workspace-scoped runners");
    expect(html).toContain("Activate runner");
    expect(html).toContain("Active shared runners");
    expect(html).toContain("Available shared runners");
    expect(html).toContain("One-time enrollment code");
    expect(html).toContain('class-hidden="!isAdmin"');
    expect(html).not.toContain("Update runner");
    expect(setup).toContain('JSON.stringify({ scope: "team", teamId })');
    expect(setup).toContain('method: active ? "POST" : "DELETE"');
    expect(setup).toContain("/api/v1/teams/${encodeURIComponent(teamId)}/runners");
  });
  it("keeps loop interpolations intact when the template is formatted", () => {
    const html = generateTeamSettingsHtml();
    expect(html).toContain("<span>{{ runner.version }}</span>");
    expect(html).toContain("{{ row.label }}");
  });
  it("offers team selection links from the landing UI", async () => {
    const { readFileSync } = await import("node:fs");
    const html = readFileSync(new URL("../src/teams-landing.html", import.meta.url), "utf8");
    const landing = readFileSync(new URL("../src/teams-landing.mjs", import.meta.url), "utf8");
    expect(html).toContain('<h1 class="text-2xl font-semibold">Workspaces</h1>');
    expect(html).not.toContain('class="text-xs font-semibold uppercase tracking-wider text-app-muted">Your workspaces');
    expect(html).not.toContain("Choose a workspace");
    expect(html).toContain('<main class="w-full space-y-5 py-2">');
    expect(html).toContain(
      'class="overflow-hidden rounded-2xl border border-app-border bg-white p-4 shadow-sm sm:p-5"',
    );
    expect(html).toContain('on-click="toggleCreateForm()"');
    expect(html).toContain('class-hidden="!newTeamFormOpen"');
    expect(html).toContain('id="new-team-name"');
    expect(html).toContain('aria-label="Workspace list"');

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
