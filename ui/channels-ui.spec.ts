import { describe, expect, it } from "vitest";
import source from "./channels-ui.mjs?raw";
import router from "./app-router.mjs?raw";
import shell from "./app-shell.html?raw";

describe("channels UI", () => {
  it("uses cursor pagination and the authenticated API client for scoped channel APIs", () => {
    expect(source).toContain('import { apiFetch } from "@app/api-client.mjs"');
    expect(source).toContain('query.set("after", after)');
    expect(source).toContain("/api/v1/channels");
    expect(router).toContain('path === "/channels"');
    expect(router).toContain("path.match(/^\\/workspaces\\/([^/]+)\\/channels$/)");
    expect(source).toContain('"X-Team-ID": root.dataset.workspaceId');
    expect(source).toContain("selectionGeneration");
    expect(source).toContain("You're up to date.");
  });

  it("renders message JSON as text and exposes an accessible composer and navigation", () => {
    expect(source).toContain('"Message body"');
    expect(source).toContain("JSON message body");
    expect(source).toContain("JSON.stringify(message.body, null, 2)");
    expect(shell).toContain("Channels</a");
    expect(shell).toContain("activeSection === 'workspace-channels'");
  });
});
