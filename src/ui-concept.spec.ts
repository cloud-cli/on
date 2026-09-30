import { describe, expect, it } from "vitest";
import { embedUiConcept, uiConceptPage } from "./ui-concept.js";

describe("public UI concept preview", () => {
  it("embeds its styles and interactive prototype without separate asset requests", () => {
    expect(uiConceptPage).toContain("<title>Runs · Flow</title>");
    expect(uiConceptPage).toContain("function runsPage() {");
    expect(uiConceptPage).not.toContain('href="./style.css"');
    expect(uiConceptPage).not.toContain('src="./app.js"');
    expect(uiConceptPage).toContain("Interactive concept");
  });

  it("inlines the stylesheet and script in the served page", () => {
    const page = embedUiConcept(
      '<html><head><link rel="stylesheet" href="./style.css" /><script src="./app.js" defer></script></head><body></body></html>',
      "body { color: green; }",
      "document.body.dataset.ready = 'true';",
    );

    expect(page).toContain("<style>body { color: green; }</style>");
    expect(page).toContain("<script>document.body.dataset.ready = 'true';</script></body>");
    expect(page).not.toContain('href="./style.css"');
    expect(page).not.toContain('src="./app.js"');
  });
});
