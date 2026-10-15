import { describe, expect, it, vi } from "vitest";
import { generateTeamSettingsHtml } from "./team-settings-ui.js";
import { generateSettingsHtml } from "./settings-ui.js";
import setup from "./team-settings-ui.mjs?raw";
import { WebhookServer } from "../src/server.js";

describe("team settings UI", () => {
  it("provides workspace-specific settings and management actions", () => {
    const html = generateTeamSettingsHtml();

    expect(html).toContain("{{ teamName }} workspace");
    expect(html).toContain("Get link");
    expect(html).toContain("Create webhook");
    expect(html).toContain("Webhook URL slug.");
    expect(html).toContain('for="member of members"');
    expect(html).toContain('class-hidden="!isAdmin"');
    expect(html).toContain('script setup src="/team-settings-ui.mjs"');
    expect(html).not.toContain("Personal settings</a>");
    expect(html.match(/rounded-xl border border-flow-border bg-flow-card p-5/g)).toHaveLength(5);
    expect(html).toContain('aria-label="Workspace settings sections"');
    expect(html).toContain(
      'class="sticky top-0 z-10 flex flex-wrap items-center justify-between gap-3 border-b border-flow-border bg-flow-background py-2"',
    );
    expect(
      html.match(/rounded-md border border-flow-border bg-white px-2\.5 py-1\.5 text-xs font-medium/g),
    ).toHaveLength(5);
    expect(html).toContain('href="#team-members"');
    expect(html).toContain('href="#team-webhooks"');
    expect(html).toContain('href="#team-runners"');
    expect(html).toContain('href="#workspace-api-keys"');
    expect(html).toContain('href="#workspace-secrets"');
    expect(html).toContain('<h2 id="team-runners-title" class="text-lg font-semibold">Task Runners</h2>');
    expect(html).toContain('<h2 id="workspace-api-keys-title" class="text-lg font-semibold">API keys</h2>');
    expect(html).toContain('<h2 id="workspace-secrets-title" class="text-lg font-semibold">Task Runner Secrets</h2>');
    expect(html).toContain("bg-flow-warning/10");
    expect(html).toContain("text-flow-warning");
    expect(html).toContain('placeholder="API key name"');
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

  it("places invitation entry after members and secrets before API keys", () => {
    const html = generateTeamSettingsHtml();
    const members = html.indexOf('id="team-members"');
    const invitationForm = html.indexOf('on-submit.prevent="createInvitation()"');
    const invitationSection = html.lastIndexOf('class="mt-6 border-t border-flow-border pt-5"', invitationForm);
    const webhooks = html.indexOf('id="team-webhooks"');
    const secrets = html.indexOf('id="workspace-secrets"');
    const apiKeys = html.indexOf('id="workspace-api-keys"');

    expect(invitationForm).toBeGreaterThan(members);
    expect(invitationForm).toBeLessThan(webhooks);
    expect(invitationSection).toBeGreaterThan(members);
    expect(html.slice(invitationSection, webhooks)).toContain('class="mt-3 flex gap-2"');
    expect(html.slice(invitationSection, webhooks)).toContain("Get link");
    expect(secrets).toBeGreaterThan(webhooks);
    expect(apiKeys).toBeGreaterThan(secrets);
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

  it("manages workspace secrets and scoped API keys in workspace settings only", () => {
    const html = generateTeamSettingsHtml();
    expect(html).toContain("API keys");
    expect(html).toContain("Task Runner Secrets");
    expect(html).toContain("Copy this key now. It cannot be shown again.");
    expect(setup).toContain("/api/v1/workspaces/${encodeURIComponent(teamId)}/api-keys");
    expect(setup).toContain("/api/v1/secrets/");
    expect(setup).toContain('"X-Team-ID": teamId');
    expect(generateSettingsHtml()).not.toContain("API keys");
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
    expect(html).toContain("<span>{{ scope.label }}</span>");
  });
  it("offers team selection links from the landing UI", async () => {
    const { readFileSync } = await import("node:fs");
    const html = readFileSync(new URL("../src/teams-landing.html", import.meta.url), "utf8");
    const landing = readFileSync(new URL("../src/teams-landing.mjs", import.meta.url), "utf8");
    expect(html).toContain('<h1 class="text-2xl font-semibold">Your workspaces</h1>');
    expect(html).not.toContain(
      'class="text-xs font-semibold uppercase tracking-wider text-flow-muted">Your workspaces',
    );
    expect(html).not.toContain("Choose a workspace");
    expect(html).toContain('<main class="w-full space-y-5 py-2">');
    expect(html).toContain(
      'class="flex flex-wrap items-center gap-3 rounded-xl border border-flow-border bg-white p-5"',
    );
    expect(html).toContain('class="flex w-full flex-wrap items-center gap-2 sm:ml-auto sm:w-auto"');
    expect(html).toContain('class="rounded-xl border border-flow-border bg-white p-5" aria-label="Workspace list"');
    expect(html).toContain('class="rounded-xl border border-flow-border bg-white p-5"');

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
