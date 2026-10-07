import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { Script } from "node:vm";
import { embedUiConcept, uiConceptPage } from "./ui-concept.js";
import previewLiveSource from "../docs/ui-concept/preview-live.mjs?raw";

describe("public UI concept preview", () => {
  it("serves a syntactically valid live preview module", () => {
    const source = previewLiveSource.replace("export function mountLivePreview", "function mountLivePreview");
    expect(() => new Script(source)).not.toThrow();
    expect(previewLiveSource).not.toContain("setInterval");
    expect(previewLiveSource).not.toContain("of ${filtered.length} runs");
    expect(previewLiveSource).not.toContain("Older Flow runs are available.");
    expect(previewLiveSource).toContain('data-action="prev-page"');
    expect(previewLiveSource).toContain('data-action="next-page"');
  });

  it("forwards qualified run searches to the jobs API and filters demo repositories", () => {
    const demo = readFileSync(new URL("../docs/ui-concept/app.js", import.meta.url), "utf8");

    expect(previewLiveSource).toContain('query.set("filter", state.search.trim())');
    expect(previewLiveSource).toContain("const hasQualifier = /^[a-z0-9_-]+:.+$/i.test(search)");
    expect(demo).toContain("search.match(/^([a-z0-9_-]+):(.+)$/)");
    expect(demo).toContain('qualifier[1] === "owner"');
    expect(demo).toContain('qualifier[1] === "repo"');
  });

  it("keeps run status navigation while removing the runs breadcrumb and header chrome", () => {
    const markup = readFileSync(new URL("../docs/ui-concept/index.html", import.meta.url), "utf8");
    const demo = readFileSync(new URL("../docs/ui-concept/app.js", import.meta.url), "utf8");

    expect(markup).not.toContain('id="breadcrumbs"');
    expect(markup).not.toContain("topbar-right");
    expect(demo).not.toContain('document.querySelector("#breadcrumbs")');
    expect(demo).toContain('"In progress"');
    expect(previewLiveSource).toContain('"In progress"');
    expect(previewLiveSource).not.toContain("Older Flow runs are available.");
  });

  it("renders workflows as revision-labelled rows with accessible icon-only actions", () => {
    const demo = readFileSync(new URL("../docs/ui-concept/app.js", import.meta.url), "utf8");

    expect(demo).toContain('class="workflow-item"');
    expect(demo).toContain("v${workflow.revision || 1}");
    expect(demo).toContain('aria-label="View source for ${workflow.name}"');
    expect(previewLiveSource).toContain("workflow.revision || 1");
    expect(previewLiveSource).toContain('aria-label="Edit ${escape(workflow.name || workflow.id)}"');
    expect(previewLiveSource).toContain('aria-label="View runs for ${escape(');
    expect(previewLiveSource).not.toContain('<span class="workflow-icon">');
    expect(previewLiveSource).toContain('class="workflow-list mt-4"');
  });

  it("keeps workers, secrets, tokens, timezone, and the admin roster in Settings", () => {
    const demo = readFileSync(new URL("../docs/ui-concept/app.js", import.meta.url), "utf8");

    expect(demo).not.toContain('["workers", "Workers", "server"]');
    expect(demo).toContain('else if (page === "workers")');
    expect(demo).toContain("${workerCards()}");
    expect(demo).toContain('id="timezone-setting"');
    expect(demo).toContain("Admin roster");
    expect(demo).not.toContain("Workflow editing</h2>");
    expect(previewLiveSource).not.toContain('["workers", "Workers", "server"]');
    expect(previewLiveSource).toContain('apiJson("/api/api-keys")');
    expect(previewLiveSource).toContain('apiJson("/api/preferences")');
    expect(previewLiveSource).toContain('apiJson("/api/users")');
    expect(previewLiveSource).toContain('apiJson("/api/workers")');
    expect(previewLiveSource).toContain('class="mono min-w-0 max-w-[min(58vw,480px)] truncate"');
    expect(previewLiveSource).not.toContain("Workflow editing</h2>");
  });

  it("provides a signed-in profile link and compact role badge in the sidebar", () => {
    const markup = readFileSync(new URL("../docs/ui-concept/index.html", import.meta.url), "utf8");

    expect(markup).toContain('id="profile-link"');
    expect(markup).toContain('target="_blank"');
    expect(markup).toContain('rel="noopener noreferrer"');
    expect(markup).toContain('id="profile-name"');
    expect(markup).toContain('id="profile-email"');
    expect(markup).toContain('id="profile-role"');
    expect(markup).toContain('data-icon="external"');
    expect(previewLiveSource).toContain('apiJson("/api/session")');
    expect(previewLiveSource).toContain("link.href = profileUrl.toString()");
  });

  it("embeds its styles and interactive prototype without separate asset requests", () => {
    expect(uiConceptPage).toContain("<title>Runs · Flow</title>");
    expect(uiConceptPage).toContain("function runsPage() {");
    expect(uiConceptPage).toContain("/preview-live.mjs");
    expect(uiConceptPage).toContain('get("demo") === "1"');
    expect(uiConceptPage).not.toContain('href="./style.css"');
    expect(uiConceptPage).not.toContain('src="./app.js"');
    expect(uiConceptPage).not.toContain("Interactive concept");
  });

  it("inlines the stylesheet and script in the served page", () => {
    const page = embedUiConcept(
      '<html><head><link rel="stylesheet" href="./style.css" /><script src="./app.js" defer></script></head><body></body></html>',
      "body { color: green; }",
      "document.body.dataset.ready = 'true';",
    );

    expect(page).toContain("<style>body { color: green; }</style>");
    expect(page).toContain('<link rel="stylesheet" href="/on.css" />');
    expect(page).toContain("document.body.dataset.ready = 'true';");
    expect(page).toContain('void import("/preview-live.mjs")');
    expect(page).toContain("</script></body>");
    expect(page).not.toContain('href="./style.css"');
    expect(page).not.toContain('src="./app.js"');
  });

  it("scans preview markup and declares the Flow design tokens in Tailwind v4", () => {
    const tailwind = readFileSync(new URL("./index.css", import.meta.url), "utf8");

    expect(tailwind).toContain('@source "../docs/ui-concept/**/*.{html,js,mjs}"');
    expect(tailwind).toContain("--color-flow-background: #f3f5f1");
    expect(tailwind).toContain("--color-flow-sidebar: #e9eee6");
    expect(tailwind).toContain("--color-flow-muted: #505b52");
    expect(tailwind).toContain('--font-sans: "DM Sans"');
  });

  it("uses Tailwind utilities for the shared preview shell and responsive navigation", () => {
    const markup = readFileSync(new URL("../docs/ui-concept/index.html", import.meta.url), "utf8");
    const demo = readFileSync(new URL("../docs/ui-concept/app.js", import.meta.url), "utf8");
    const styles = readFileSync(new URL("../docs/ui-concept/style.css", import.meta.url), "utf8");

    expect(markup).toContain("fixed inset-y-0 left-0");
    expect(markup).toContain("max-[600px]:bottom-0");
    expect(markup).toContain("ml-56 flex min-h-screen");
    expect(markup).toContain("brand-mark mr-[10px]");
    expect(markup).toContain("workspace mx-[2px] my-[38px]");
    expect(markup).toContain("profile flex w-full");
    expect(demo).toContain("max-[900px]:justify-center");
    expect(demo).toContain("max-[900px]:hidden max-[600px]:block");
    expect(previewLiveSource).toContain("max-[600px]:flex-col");
    expect(previewLiveSource).toContain("max-[900px]:justify-center");
    expect(styles).not.toMatch(
      /\.(?:sidebar|brand|brand-mark|workspace|workspace-icon|workspace-label|nav-caption|nav-item|nav-count|sidebar-bottom|runner-health|health-dot|profile|avatar|breadcrumbs|app-shell|topbar|topbar-right)\b[^\n]*\{/,
    );
  });
});
