import { describe, expect, it } from "vitest";
import { generateTeamSettingsHtml } from "./team-settings-ui.js";
import setup from "./team-settings-ui.mjs?raw";

describe("team settings UI", () => {
  it("provides team-specific settings and existing team management actions", () => {
    const html = generateTeamSettingsHtml();

    expect(html).toContain("{{ teamName }} settings");
    expect(html).toContain('bind-value="newTeamName"');
    expect(html).toContain("Create team");
    expect(html).toContain("Create invite link");
    expect(html).toContain("Generate / rotate webhook URL");
    expect(html).toContain('for="member of members"');
    expect(html).toContain('class-hidden="!isAdmin"');
    expect(html).toContain('script setup src="/team-settings-ui.mjs"');
  });

  it("loads and mutates only the team identified by the route", () => {
    expect(setup).toContain('location.pathname.split("/")[2]');
    expect(setup).toContain("request(`/api/teams/${encodeURIComponent(teamId)}/members`)");
    expect(setup).toContain("request(`/api/teams/${encodeURIComponent(teamId)}/invitations`");
    expect(setup).toContain("request(`/api/teams/${encodeURIComponent(teamId)}/webhook-token`");
    expect(setup).toContain('"X-Team-ID": teamId');
    expect(setup).toContain('if (!team) throw new Error("You are not a member of this team.")');
  });
});
