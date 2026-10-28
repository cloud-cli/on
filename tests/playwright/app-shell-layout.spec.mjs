import fs from "node:fs";
import { fileURLToPath } from "node:url";
import { expect, test } from "@playwright/test";

const shell = fs.readFileSync(fileURLToPath(new URL("../../ui/app-shell.html", import.meta.url)), "utf8");
const classFrom = (pattern) => {
  const match = shell.match(pattern);
  if (!match) {
    throw new Error(`Could not locate shell class using ${pattern}`);
  }
  return match[1];
};
const classes = {
  layout: classFrom(/data-app-layout\s+class="([^"]+)"/),
  rail: classFrom(/data-workspace-rail[\s\S]*?class="([^"]+)"/),
  sidebar: classFrom(/id="primary-sidebar"\s+class="([^"]+)"/),
  globalNav: classFrom(/aria-label="Global navigation"\s+class="([^"]+)"/),
  workspaceNav: classFrom(/aria-label="Workspace navigation"\s+class="([^"]+)"/),
  divider: classFrom(/class="([^"]*border-t border-app-border[^"]*)"/),
  workspaceTitle: classFrom(/class="([^"]*basis-full truncate px-3 py-1[^"]*)"[\s\S]*?{{ team\.name }}/),
  globalLink: classFrom(/href="\/ui\/workspaces"\s+on-click="setActive\('workspaces'\)"[\s\S]*?class="([^"]+)"/),
  workflowLink: classFrom(/attr-href="workspacePath\(team\.id, 'workflows'\)"[\s\S]*?class="([^"]+)"/),
  runsLink: classFrom(/attr-href="workspacePath\(team\.id, 'runs'\)"[\s\S]*?class="([^"]+)"/),
  streamsHeading: classFrom(/class="([^"]+)"\s*>\s*Streams</),
  streamLink: classFrom(/for="channel of workspaceChannels"[\s\S]*?class="([^"]+)"/),
  content: classFrom(/<div\s+class="(col-start-2 row-start-2 grid[^"]+)"/),
  header: classFrom(/<header class="([^"]+)"/),
  search: classFrom(/data-quick-switch-open\s+class="([^"]+)"/),
  panel: classFrom(/<section class="(max-h-full min-h-0 min-w-0 overflow-y-auto[^"]+)"/),
};

const fixture = `
  <div id="layout" class="${classes.layout}">
    <aside data-workspace-rail class="${classes.rail}">Rail</aside>
    <aside id="primary-sidebar" class="${classes.sidebar}">
      <nav aria-label="Global navigation" class="${classes.globalNav}">
        <a class="${classes.globalLink}">Workspaces</a>
        <a class="${classes.globalLink}">Recipes</a>
      </nav>
      <div class="${classes.divider}"></div>
      <nav aria-label="Workspace navigation" class="${classes.workspaceNav}">
        <span data-workspace-title class="${classes.workspaceTitle}">AppHorde</span>
        <a data-workflow-link class="${classes.workflowLink}">Workflows</a>
        <a data-runs-link class="${classes.runsLink}">Runs</a>
        <span data-streams-heading class="${classes.streamsHeading}">Streams</span>
        <a data-stream-link title="A synthetic Stream name that is intentionally too long for the sidebar" class="${classes.streamLink}">
          <span class="min-w-0 truncate">A synthetic Stream name that is intentionally too long for the sidebar</span>
        </a>
      </nav>
    </aside>
    <div class="${classes.content}">
      <header class="${classes.header}"><button data-quick-switch-open class="${classes.search}">Search workspaces, streams, routes…</button></header>
      <section class="${classes.panel}"><main id="main-content"></main></section>
    </div>
  </div>
`;

for (const viewport of [
  { name: "desktop", width: 1440, height: 900, desktop: true },
  { name: "tablet", width: 768, height: 900, desktop: true },
  { name: "mobile", width: 390, height: 844, desktop: false },
  { name: "narrow-mobile", width: 320, height: 720, desktop: false },
]) {
  test(`shell navigation and quick switch layout at ${viewport.name}`, async ({ page }, testInfo) => {
    await page.setViewportSize({ width: viewport.width, height: viewport.height });
    await page.goto("/tests/playwright/channel-harness.html");
    await page.setContent(fixture);
    await page.addStyleTag({ url: "/ui/index.css" });
    await expect(page.locator("#primary-sidebar")).toBeVisible();

    const geometry = await page.evaluate(() => {
      const box = (selector) => {
        const rect = document.querySelector(selector).getBoundingClientRect();
        return { x: rect.x, y: rect.y, right: rect.right, bottom: rect.bottom, width: rect.width };
      };
      return {
        viewport: innerWidth,
        documentWidth: document.documentElement.scrollWidth,
        rail: box("[data-workspace-rail]"),
        sidebar: box("#primary-sidebar"),
        content: box(".col-start-2.row-start-2"),
        panel: box("section"),
        header: box("header"),
        search: box("[data-quick-switch-open]"),
        headerPadding: (() => {
          const style = getComputedStyle(document.querySelector("header"));
          return parseFloat(style.paddingLeft) + parseFloat(style.paddingRight);
        })(),
        title: box("[data-workspace-title]"),
        workflow: box("[data-workflow-link]"),
        runs: box("[data-runs-link]"),
        streamsHeading: box("[data-streams-heading]"),
        stream: box("[data-stream-link]"),
        streamText: getComputedStyle(document.querySelector("[data-stream-link] span")).textOverflow,
        workspaceDirection: getComputedStyle(document.querySelector('[aria-label="Workspace navigation"]'))
          .flexDirection,
        workspaceWrap: getComputedStyle(document.querySelector('[aria-label="Workspace navigation"]')).flexWrap,
        titleBasis: getComputedStyle(document.querySelector("[data-workspace-title]")).flexBasis,
      };
    });

    expect(geometry.documentWidth).toBeLessThanOrEqual(geometry.viewport);
    expect(geometry.rail.width).toBeCloseTo(64, 0);
    if (viewport.desktop) {
      expect(geometry.sidebar.width).toBeCloseTo(224, 0);
      expect(geometry.content.x).toBeCloseTo(288, 0);
      expect(geometry.workspaceDirection).toBe("column");
      expect(geometry.workspaceWrap).toBe("nowrap");
      expect(geometry.titleBasis).toBe("auto");
      const headerInnerWidth = geometry.header.width - geometry.headerPadding;
      expect(geometry.search.width).toBeCloseTo(headerInnerWidth / 2, 0);
      expect(geometry.search.x + geometry.search.width / 2).toBeCloseTo(
        geometry.header.x + geometry.header.width / 2,
        0,
      );
      expect(geometry.title.x).toBeCloseTo(geometry.workflow.x, 0);
      expect(geometry.workflow.x).toBeCloseTo(geometry.runs.x, 0);
      expect(geometry.runs.x).toBeCloseTo(geometry.streamsHeading.x, 0);
      expect(geometry.streamsHeading.x).toBeCloseTo(geometry.stream.x, 0);
      expect(geometry.title.y).toBeLessThan(geometry.workflow.y);
      expect(geometry.workflow.y).toBeLessThan(geometry.runs.y);
      expect(geometry.runs.y).toBeLessThan(geometry.streamsHeading.y);
      expect(geometry.streamsHeading.y).toBeLessThan(geometry.stream.y);
      expect(geometry.streamText).toBe("ellipsis");
    } else {
      expect(geometry.sidebar.x).toBeCloseTo(64, 0);
      expect(geometry.sidebar.y).toBeLessThan(geometry.content.y);
      expect(geometry.sidebar.bottom).toBeLessThanOrEqual(geometry.content.y);
      expect(geometry.search.width).toBeCloseTo(geometry.header.width - geometry.headerPadding, 0);
    }
    await page.screenshot({ path: testInfo.outputPath(`shell-${viewport.name}.png`), fullPage: true });
  });
}
