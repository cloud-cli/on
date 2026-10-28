import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const setupSource = readFileSync(
  resolve(process.cwd(), "ui/incoming-events.mjs"),
  "utf8",
);
const templateSource = readFileSync(
  resolve(process.cwd(), "ui/incoming-events.html"),
  "utf8",
);

describe("incoming events Li3 UI", () => {
  it("keeps rendering and interaction out of imperative DOM APIs", () => {
    expect(setupSource).not.toMatch(
      /\bdocument\b|\bquerySelector\b|\bcreateElement\b/,
    );
    expect(setupSource).not.toMatch(
      /\.\s*(?:textContent|innerHTML|classList|replaceChildren)\b/,
    );
    expect(setupSource).not.toMatch(
      /\.\s*(?:append|appendChild|addEventListener|removeEventListener)\s*\(/,
    );
  });

  it("declares the events table and actions with Li3 bindings", () => {
    expect(templateSource).toContain('<template for="event of events">');
    expect(templateSource).toContain('on-click="openDetail(event.id)"');
    expect(templateSource).toContain('on-click="retrigger()"');
    expect(templateSource).toContain('attr-href="runsUrl"');
    expect(templateSource).toContain('bind-class="event.statusClass"');
  });
});
