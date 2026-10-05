import { describe, expect, it } from "vitest";
import { Script } from "node:vm";
import { embedUiConcept, uiConceptPage } from "./ui-concept.js";
import previewLiveSource from "../docs/ui-concept/preview-live.mjs?raw";

describe("public UI concept preview", () => {
  it("serves a syntactically valid live preview module", () => {
    const source = previewLiveSource.replace("export function mountLivePreview", "function mountLivePreview");
    expect(() => new Script(source)).not.toThrow();
    expect(previewLiveSource).not.toContain("setInterval");
    expect(previewLiveSource).not.toContain("of ${filtered.length} runs");
    expect(previewLiveSource).toContain('data-action="prev-page"');
    expect(previewLiveSource).toContain('data-action="next-page"');
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
      "document.body.dataset.ready = 'true';"
    );

    expect(page).toContain("<style>body { color: green; }</style>");
    expect(page).toContain("document.body.dataset.ready = 'true';");
    expect(page).toContain('void import("/preview-live.mjs")');
    expect(page).toContain("</script></body>");
    expect(page).not.toContain('href="./style.css"');
    expect(page).not.toContain('src="./app.js"');
  });
});
