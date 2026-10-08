import { describe, expect, it } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { generateWorkflowManagementHtml } from "./workflows-ui.js";
import workflowsSetup from "./workflows-ui.mjs?raw";
import { WebhookServer } from "./server.js";

describe("workflow management UI", () => {
  it("keeps declared custom-element imports in the app-router page component", () => {
    const response = { writeHead: () => response, end: (html: string) => html };
    const source = generateWorkflowManagementHtml("editor", "example");
    const html = (WebhookServer.prototype as any).renderPageComponent.call(
      {},
      response,
      "page-workflow-editor",
      source,
    );

    expect(html).toContain('<link rel="component" href="https://sodium.static.apphor.de/code-editor.html" />');
    expect(html).toContain('<link rel="component" href="https://sodium.static.apphor.de/code-block.html" />');
    expect(html).not.toContain("app-header");
    expect(html).toContain('<link rel="stylesheet" href="/on.css" />');
    expect(html).toContain("<code-editor");
    expect(html).toContain("Workflow syntax help");
  });

  it("defines every Flow color utility and keeps app pages free of inline styles", () => {
    const sourceDir = new URL(".", import.meta.url).pathname;
    const pageFiles = readdirSync(sourceDir).filter((file) => file.endsWith(".html"));
    const pageSource = pageFiles.map((file) => readFileSync(join(sourceDir, file), "utf8")).join("\n");
    const theme = readFileSync(join(sourceDir, "index.css"), "utf8");
    const tokens = new Set([...theme.matchAll(/--color-flow-([a-z-]+)\s*:/g)].map((match) => match[1]));
    const usedTokens = new Set(
      [...pageSource.matchAll(/(?:bg|text|border|divide|ring|shadow)-flow-([a-z-]+)/g)].map((match) => match[1]),
    );
    const missingTokens = [...usedTokens].filter((token) => !tokens.has(token));

    expect(missingTokens).toEqual([]);
    expect(pageSource).not.toMatch(/<style\b/i);
  });

  it("provides authenticated workflow and write-only secret controls", () => {
    const html = generateWorkflowManagementHtml("editor", "example");
    const source = html + workflowsSetup;

    expect(source).toContain("<code-editor");
    expect(source).toContain('id="source-yaml"');
    expect(source).toContain("https://sodium.static.apphor.de/code-editor.html");
    expect(source).toContain("https://sodium.static.apphor.de/code-block.html");
    expect(source).toContain("https://sodium.static.apphor.de/lucide-icon.html");
    expect(source).toContain("<template app>");
    expect(source).toContain("/api/workflows/validate");
    expect(source).toMatch(/credentials:\s*['"]same-origin['"]/);
    expect(source).not.toContain("@app/api-client.mjs");
    expect(source).toContain("const name = secretName.value.trim().toUpperCase()");
    expect(source).toContain("secretName.value.trim().toUpperCase() === name");
    expect(source).toContain("Secret names must start with a letter");
    expect(source).toContain("initialId || `wf-${crypto.randomUUID()}`");
    expect(source).toContain(
      'const page = workflowPath ? "editor" : document.body.dataset.page || params.get("page") || "workflows"',
    );
    expect(source).toContain("? openWorkflow(initialId)");
    expect(source).toContain("const workflow = await api(workflowUrl)");
    expect(source).not.toContain("derivedId");
    expect(source).toContain("Save draft");
    expect(source).toContain('href="/workflows/new"');
    expect(source).not.toContain('aria-label="Workflow count"');
    expect(source).toContain("text-base font-semibold text-flow-foreground");
    expect(source).toContain('type="checkbox"');
    expect(source).toContain('bind-checked="enabled"');
    expect(source).not.toContain("Internal workflow ID");
    expect(source).not.toContain('id="workflow-id-help"');
    expect(source).not.toContain('bind-value="workflowId"');
    expect(source).not.toContain("setWorkflowId");
    expect(source).toContain("No changes to save.");
    expect(source).not.toContain("{{ workflow.id }}");
    expect(source).toContain("{{ workflow.name }}");
    expect(source).toContain("v{{ workflow.revision }}");
    expect(source).toContain("attr-aria-label=\"'Edit ' + workflow.name\"");
    expect(source).toContain('class="sr-only">Edit {{ workflow.name }}</span>');
    expect(source).not.toContain('href="/settings/workflows"');
    expect(source).toContain("setTimeout(() =>");
    expect(source).toMatch(/validation\.value = \{\s*\.\.\.validation\.value,\s*running: true/);
    expect(source).toMatch(/validation\.value = \{\s*valid: false,\s*running: false,\s*error: error\.message\s*\}/);
    expect(source).toContain("hidden md:inline");
    expect(source).toContain("Workflow revision {{ revisionNumber }}");
    expect(source).toContain('on-click="navigateRevision(-1)"');
    expect(source).toContain('bind-innerhtml="revisionDiffHtml"');
    expect(source).toContain("https://unpkg.com/diff@9.0.0/libesm/index.js");
    expect(source).toContain("Get AI workflow help");
    expect(source).toContain("/api/ai/workflow-help");
    expect(source).toContain("Accept suggestion");
    expect(source).toContain('aria-label="Save workflow draft"');
    expect(source).toContain(
      'bind-disabled="busy || !selectedId || source !== savedSource || enabled !== savedEnabled"',
    );
    expect(source).toContain('aria-labelledby="workflow-list-title"');
    expect(source).toContain("attr-href=\"'/workflows/' + workflow.id\"");
    expect(source).toContain('href="/workflows"');
    expect(source).toContain("Back to workflows");
    expect(source).not.toContain("<app-header");
    expect(source).not.toContain("Workflow control room");
    expect(source).not.toContain("Definitions</p>");
    expect(source).not.toContain('aria-label="Secret count"');
    expect(source).toContain("class-hidden=\"workflow.status !== 'draft'\"");
    expect(source).toContain("Draft");
    expect(source).toContain('ref="helpContent"');
    expect(source).toContain('on-toggle="loadHelp($event)"');
    expect(source).toContain("new DOMParser()");
    expect(source).not.toContain("<iframe");
    expect(source).toContain("focus-visible:ring-2");
    expect(source).toContain("Publish");
    expect(source).toContain("/api/workflows/");
    expect(source).toContain("Run workflow now");
    expect(source).toContain("runNow");
    expect(source).toContain("/api/secrets/");
    expect(source).toContain('type="password"');
    expect(source).toContain('type="file"');
    expect(source).toContain("Binary file secret");
    expect(source).toContain('bind-checked="fileMode"');
    expect(source).toMatch(/encoding:\s*['"]base64['"]/);
    expect(source).toContain('on-click="removeSecret(name)"');
    expect(source).toContain('aria-label="Delete secret {{ name }}"');
    expect(source).toContain('ref="secretForm"');
    expect(source).toContain("Add a secret");
    expect(source).toContain('icon="trash"');
    expect(source).toContain('aria-label="Saved secrets"');
    expect(source).toContain('aria-label="Edit secret {{ name }}"');
    expect(source).toContain('data-page="editor"');
    expect(source).toContain("window.location.pathname.match");
    expect(source).toContain('page === "editor"');
    expect(source).toMatch(/workflowPath\[1\] !== ['"]new['"]/);
    expect(source).toMatch(/const initialId = params\.get\(["']id["']\) \|\| pathWorkflowId/);
    expect(source).toMatch(
      /const initialRevision = params\.get\(["']revision["']\) \? Number\(params\.get\(["']revision["']\)\) : null/,
    );
  });

  it("does not render settings navigation on workflow management pages", () => {
    const html = generateWorkflowManagementHtml("workflows");
    expect(html).not.toContain("Settings section navigation");
    expect(html).not.toContain('href="/settings/tokens"');
    expect(html).not.toContain('href="/settings/workers"');
  });

  it("keeps the secret form structurally inside its disclosure panel", () => {
    const source = generateWorkflowManagementHtml("secrets");
    const start = source.indexOf('<details ref="secretForm"');
    const end = source.indexOf("</details>", start);
    const form = source.slice(start, end);
    const openDivs = form.match(/<div\b/g) || [];
    const closeDivs = form.match(/<\/div>/g) || [];

    expect(start).toBeGreaterThanOrEqual(0);
    expect(end).toBeGreaterThan(start);
    expect(openDivs).toHaveLength(closeDivs.length);
  });
});
