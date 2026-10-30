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
  brand: classFrom(/aria-label="Open or expand navigation"[\s\S]*?class="([^"]+)"/),
  workspaceGroup: classFrom(/aria-label="Switch workspace"\s+class="([^"]+)"/),
  workspaceSwitch: classFrom(/attr-data-workspace-switch="team.id"[\s\S]*?class="([^"]+)"/),
  sidebar: classFrom(/id="primary-sidebar"\s+class="([^"]+)"/),
  globalNav: classFrom(/aria-label="Global navigation"\s+class="([^"]+)"/),
  workspaceNav: classFrom(/<div\s+class="([^"]+)"\s+class-hidden="!selectedWorkspaceId"/),
  divider: classFrom(/class="([^"]*border-t border-app-border[^"]*)"/),
  globalLink: classFrom(/href="\/ui\/workspaces"\s+on-click="setActive\('workspaces'\)"[\s\S]*?class="([^"]+)"/),
  workflowLink: classFrom(/attr-href="workspacePath\(selectedWorkspaceId, 'workflows'\)"[\s\S]*?class="([^"]+)"/),
  connectorLink: classFrom(/attr-href="workspacePath\(selectedWorkspaceId, 'connectors'\)"[\s\S]*?class="([^"]+)"/),
  runsLink: classFrom(/attr-href="workspacePath\(selectedWorkspaceId, 'runs'\)"[\s\S]*?class="([^"]+)"/),
  streamsHeading: classFrom(/class="([^"]+)"\s*>\s*Streams</),
  streamLink: classFrom(/for="channel of workspaceChannels"[\s\S]*?class="([^"]+)"/),
  content: classFrom(/<div\s+class="(col-start-1 row-start-2 grid[^"]+)"/),
  header: classFrom(/<header\s+class="([^"]+)"/),
  search: classFrom(/data-quick-switch-open\s+class="([^"]+)"/),
  menu: classFrom(/data-nav-open[\s\S]*?class="([^"]+)"/),
  panel: classFrom(/<section\s+class="(max-h-full min-h-0 min-w-0 overflow-y-auto[^"]+)"/),
  mainContent: classFrom(/<div id="main-content" tabindex="-1" class="([^"]+)"/),
};

const fixture = `
  <div id="layout" data-app-layout class="${classes.layout}">
    <aside data-workspace-rail aria-label="Workspace switcher" class="${classes.rail}">
      <button class="${classes.brand}" aria-label="Open or expand navigation">dimon.</button>
      <div role="group" aria-label="Switch workspace" class="${classes.workspaceGroup}">
        <button class="${classes.workspaceSwitch}" aria-pressed="true" aria-label="AppHorde">A</button>
        <button class="${classes.workspaceSwitch}" aria-pressed="false" aria-label="Builds">B</button>
        <button class="${classes.workspaceSwitch}" aria-pressed="false" aria-label="Docs">D</button>
      </div>
    </aside>
    <aside id="primary-sidebar" class="${classes.sidebar}">
      <button data-nav-close aria-label="Close navigation">Close</button>
      <nav aria-label="Global navigation" class="${classes.globalNav}">
        <h2 class="basis-full truncate px-3 py-1 text-lg font-semibold text-app-foreground md:basis-auto md:py-2">cloud-cli</h2>
        <a href="/ui/workspaces" class="${classes.globalLink}">Workspaces</a>
        <a href="/ui/recipes" class="${classes.globalLink}">Recipes</a>
        <span class="${classes.divider}"></span>
        <div aria-label="Workspace navigation" data-workspace-navigation class="${classes.workspaceNav}">
        <a href="/ui/workflows" data-workflow-link class="${classes.workflowLink}">Workflows</a>
        <a href="/ui/connectors" data-connectors-link class="${classes.connectorLink}">Connectors</a>
        <a href="/ui/runs" data-runs-link class="${classes.runsLink}">Runs</a>
        <span data-streams-heading class="${classes.streamsHeading}">Streams</span>
        <a href="/ui/stream" data-stream-link title="A synthetic Stream name that is intentionally too long for the sidebar" class="${classes.streamLink}">
          <span class="min-w-0 truncate">A synthetic Stream name that is intentionally too long for the sidebar</span>
        </a>
        </div>
      </nav>
    </aside>
    <div class="${classes.content}">
      <header class="${classes.header}"><button data-nav-open aria-expanded="false" aria-controls="primary-sidebar" class="${classes.menu}">Menu</button><button data-quick-switch-open class="${classes.search}">Search workspaces, streams, routes…</button></header>
      <section class="${classes.panel}"><main id="main-content" class="${classes.mainContent}">
        <h1 class="mb-3 text-2xl font-semibold text-app-foreground">Appearance</h1>
        <section class="mb-4 rounded-xl border border-app-border bg-app-card p-4">
          <h2 class="text-lg font-semibold">Choose how the app looks</h2>
          <p class="mt-2 text-sm text-app-secondary">Your settings adapt to this screen.</p>
        </section>
        <section class="rounded-xl border border-app-border bg-app-card p-4">
          <h2 class="text-lg font-semibold">Workspace settings</h2>
          <p class="mt-2 text-sm text-app-secondary">Your content stays full width while navigation is closed.</p>
        </section>
      </main></section>
    </div>
  </div>
`;

for (const viewport of [
  { name: "desktop", width: 1440, height: 900, desktop: true },
  { name: "tablet", width: 768, height: 900, desktop: true },
  { name: "mobile", width: 390, height: 844, desktop: false },
  { name: "mobile-619", width: 619, height: 844, desktop: false },
  { name: "mobile-767", width: 767, height: 844, desktop: false },
  { name: "narrow-mobile", width: 320, height: 720, desktop: false },
]) {
  test(`shell navigation and quick switch layout at ${viewport.name}`, async ({ page }, testInfo) => {
    await page.setViewportSize({
      width: viewport.width,
      height: viewport.height,
    });
    await page.goto("/tests/playwright/channel-harness.html");
    await page.setContent(fixture);
    await page.addStyleTag({ url: "/ui/index.css" });
    await page.evaluate(() => {
      const layout = document.querySelector("[data-app-layout]");
      const sidebar = document.querySelector("#primary-sidebar");
      const background = [
        document.querySelector("[data-workspace-rail]"),
        document.querySelector(".col-start-1.row-start-2"),
      ];
      const close = (restore = true) => {
        layout.classList.remove("navigation-open");
        background.forEach((element) => element.removeAttribute("inert"));
        document.querySelector("[data-nav-open]").setAttribute("aria-expanded", "false");
        if (restore) {
          document.querySelector("[data-nav-open]").focus();
        }
      };
      document.querySelector("[data-nav-open]").addEventListener("click", () => {
        layout.classList.add("navigation-open");
        background.forEach((element) => element.setAttribute("inert", ""));
        document.querySelector("[data-nav-open]").setAttribute("aria-expanded", "true");
        document.querySelector("[data-nav-close]").focus();
      });
      document.querySelector("[data-nav-close]").addEventListener("click", () => close());
      document.addEventListener("keydown", (event) => {
        if (event.key === "Escape") {
          close();
        }
        if (event.key === "Tab" && layout.classList.contains("navigation-open")) {
          const nodes = [...sidebar.querySelectorAll("a[href], button")];
          const index = nodes.indexOf(document.activeElement);
          if (index === nodes.length - 1 && !event.shiftKey) {
            event.preventDefault();
            nodes[0].focus();
          }
          if (index === 0 && event.shiftKey) {
            event.preventDefault();
            nodes.at(-1).focus();
          }
        }
      });
      document.addEventListener("click", (event) => {
        if (event.target.closest("[data-nav-open], [data-nav-close]")) {
          return;
        }
        if (event.target.closest("#primary-sidebar a")) {
          event.preventDefault();
          close();
        } else if (layout.classList.contains("navigation-open") && !event.target.closest("#primary-sidebar")) {
          close();
        }
      });
    });
    if (viewport.desktop) {
      await expect(page.locator("#primary-sidebar")).toBeVisible();
    } else {
      await expect(page.locator("#primary-sidebar")).toBeHidden();
    }

    const geometry = await page.evaluate(() => {
      const box = (selector) => {
        const rect = document.querySelector(selector).getBoundingClientRect();
        return {
          x: rect.x,
          y: rect.y,
          right: rect.right,
          bottom: rect.bottom,
          width: rect.width,
        };
      };
      return {
        viewport: innerWidth,
        documentWidth: document.documentElement.scrollWidth,
        rail: box("[data-workspace-rail]"),
        sidebar: box("#primary-sidebar"),
        content: box(".col-start-1.row-start-2"),
        panel: box("section"),
        header: box("header"),
        search: box("[data-quick-switch-open]"),
        menu: box("[data-nav-open]"),
        headerPadding: (() => {
          const style = getComputedStyle(document.querySelector("header"));
          return parseFloat(style.paddingLeft) + parseFloat(style.paddingRight);
        })(),
        workflow: box("[data-workflow-link]"),
        runs: box("[data-runs-link]"),
        streamsHeading: box("[data-streams-heading]"),
        stream: box("[data-stream-link]"),
        streamText: getComputedStyle(document.querySelector("[data-stream-link] span")).textOverflow,
        connectors: box("[data-connectors-link]"),
        workspaceDirection: getComputedStyle(document.querySelector("[data-workspace-navigation]")).flexDirection,
        workspaceWrap: getComputedStyle(document.querySelector("[data-workspace-navigation]")).flexWrap,
      };
    });

    expect(geometry.documentWidth).toBeLessThanOrEqual(geometry.viewport);
    if (viewport.desktop) {
      expect(geometry.rail.width).toBeCloseTo(64, 0);
      expect(geometry.sidebar.width).toBeCloseTo(224, 0);
      expect(geometry.content.x).toBeCloseTo(288, 0);
      expect(geometry.workspaceDirection).toBe("column");
      expect(geometry.workspaceWrap).toBe("nowrap");
      expect(geometry.connectors.width).toBeCloseTo(geometry.runs.width, 0);
      const headerInnerWidth = geometry.header.width - geometry.headerPadding;
      expect(geometry.search.width).toBeCloseTo(headerInnerWidth / 2, 0);
      expect(geometry.search.x + geometry.search.width / 2).toBeCloseTo(
        geometry.header.x + geometry.header.width / 2,
        0,
      );
      expect(geometry.workflow.x).toBeCloseTo(geometry.runs.x, 0);
      expect(geometry.runs.x).toBeCloseTo(geometry.streamsHeading.x, 0);
      expect(geometry.streamsHeading.x).toBeCloseTo(geometry.stream.x, 0);
      expect(geometry.workflow.y).toBeLessThan(geometry.runs.y);
      expect(geometry.runs.y).toBeLessThan(geometry.streamsHeading.y);
      expect(geometry.streamsHeading.y).toBeLessThan(geometry.stream.y);
      expect(geometry.streamText).toBe("ellipsis");
    } else {
      expect(geometry.rail.width).toBeCloseTo(viewport.width, 0);
      expect(geometry.sidebar.width).toBe(0);
      expect(geometry.content.x).toBe(0);
      expect(geometry.content.width).toBeCloseTo(viewport.width, 0);
      expect(geometry.search.width).toBeGreaterThan(0);
      expect(geometry.search.right).toBeLessThanOrEqual(geometry.header.right);
      expect(geometry.search.x).toBeGreaterThan(geometry.menu.right);
      await page.locator("[data-nav-open]").click();
      await expect(page.locator("#primary-sidebar")).toBeVisible();
      const fullWidthNavigation = await page.evaluate(() => {
        const sidebar = document.querySelector("#primary-sidebar");
        const workflow = document.querySelector("[data-workflow-link]");
        const connectors = document.querySelector("[data-connectors-link]");
        const runs = document.querySelector("[data-runs-link]");
        const globalLinks = [...document.querySelectorAll('[aria-label="Global navigation"] > a')];
        return {
          expectedWidth: sidebar.getBoundingClientRect().width - 32,
          workflow: workflow.getBoundingClientRect().width,
          connectors: connectors.getBoundingClientRect().width,
          runs: runs.getBoundingClientRect().width,
          globalLinks: globalLinks.map((link) => link.getBoundingClientRect().width),
        };
      });
      expect(fullWidthNavigation.workflow).toBeCloseTo(fullWidthNavigation.expectedWidth, 0);
      expect(fullWidthNavigation.connectors).toBeCloseTo(fullWidthNavigation.workflow, 0);
      expect(fullWidthNavigation.runs).toBeCloseTo(fullWidthNavigation.workflow, 0);
      for (const width of fullWidthNavigation.globalLinks) {
        expect(width).toBeCloseTo(fullWidthNavigation.expectedWidth, 0);
      }
      const drawerWidth = await page
        .locator("#primary-sidebar")
        .evaluate((element) => element.getBoundingClientRect().width);
      expect(drawerWidth).toBeCloseTo(Math.min(352, viewport.width - 32), 0);
      await expect(page.locator("[data-nav-open]")).toHaveAttribute("aria-expanded", "true");
      await expect(page.locator(".col-start-1.row-start-2")).toHaveAttribute("inert", "");
      await expect(page.locator("[data-workspace-rail]")).toHaveAttribute("inert", "");
      await page.locator("[data-nav-close]").focus();
      await page.keyboard.press("Shift+Tab");
      await expect(page.locator("#primary-sidebar a").last()).toBeFocused();
      await page.keyboard.press("Tab");
      await expect(page.locator("[data-nav-close]")).toBeFocused();
      await page.keyboard.press("Escape");
      await expect(page.locator("#primary-sidebar")).toBeHidden();
      await expect(page.locator("[data-nav-open]")).toBeFocused();
      await expect(page.locator(".col-start-1.row-start-2")).not.toHaveAttribute("inert", "");
      await expect(page.locator("[data-workspace-rail]")).not.toHaveAttribute("inert", "");
      await page.locator("[data-nav-open]").click();
      await page.locator("[data-nav-close]").click();
      await expect(page.locator("#primary-sidebar")).toBeHidden();
      await page.locator("[data-nav-open]").click();
      await page.locator("#layout").click({ position: { x: viewport.width - 2, y: viewport.height - 2 } });
      await expect(page.locator("#primary-sidebar")).toBeHidden();
      await page.locator("[data-nav-open]").click();
      await page.locator("#primary-sidebar a[href='/ui/recipes']").click();
      await expect(page.locator("#primary-sidebar")).toBeHidden();
      await expect(page.locator("[data-nav-open]")).toBeFocused();
    }
    await page.screenshot({
      path: testInfo.outputPath(`shell-${viewport.name}.png`),
      fullPage: true,
    });
    if (!viewport.desktop) {
      await page.locator("[data-nav-open]").click();
      await expect(page.locator("#primary-sidebar")).toBeVisible();
      await page.screenshot({
        path: testInfo.outputPath(`shell-${viewport.name}-drawer.png`),
        fullPage: true,
      });
    }
  });
}
