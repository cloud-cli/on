import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const setupSource = readFileSync(resolve(process.cwd(), "ui/incoming-events.mjs"), "utf8");
const templateSource = readFileSync(resolve(process.cwd(), "ui/incoming-events.html"), "utf8");

describe("incoming events Li3 UI", () => {
  it("keeps rendering and interaction out of imperative DOM APIs", () => {
    expect(setupSource).not.toMatch(/\bdocument\b|\bquerySelector\b|\bcreateElement\b/);
    expect(setupSource).not.toMatch(/\.\s*(?:textContent|innerHTML|classList|replaceChildren)\b/);
    expect(setupSource).not.toMatch(/\.\s*(?:append|appendChild|addEventListener|removeEventListener)\s*\(/);
  });

  it("declares the events table and actions with Li3 bindings", () => {
    expect(templateSource).toContain('<template for="event of events">');
    expect(templateSource).toContain('on-click="openDetail(event.id)"');
    expect(templateSource).toContain('on-click="retrigger()"');
    expect(templateSource).toContain('attr-href="runsUrl"');
    expect(templateSource).toContain('bind-class="event.statusClass"');
  });

  it("matches the full-width runs layout without an intro heading or card border", () => {
    expect(templateSource).toContain('<main class="w-full space-y-6 py-2">');
    expect(templateSource).toContain('class="flex gap-2 border-b border-app-border"');
    expect(templateSource).not.toContain("Workspace activity");
    expect(templateSource).not.toContain("Inspect every accepted webhook delivery");
    expect(templateSource).not.toContain("<h1");
    expect(templateSource).toContain('class="overflow-hidden rounded-2xl bg-white"');
    expect(templateSource).not.toContain('class="overflow-hidden rounded-2xl border border-app-border bg-white"');
    expect(templateSource).toContain('aria-label="Incoming events table"');
    expect(templateSource).toContain("w-full min-w-[680px] text-left text-sm");
  });
});
