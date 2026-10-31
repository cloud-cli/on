import fs from "node:fs";
import { fileURLToPath } from "node:url";
import { expect, test } from "@playwright/test";

const html = fs.readFileSync(fileURLToPath(new URL("../../ui/connectors-ui.html", import.meta.url)), "utf8");
const classFrom = (pattern) => {
  const match = html.match(pattern);
  if (!match) {
    throw new Error(`Unable to find connector list classes using ${pattern}`);
  }
  return match[1];
};
const classes = {
  main: classFrom(/<main class="([^"]+)"/),
  card: classFrom(/<section\s+class="([^"]+)"\s+class-hidden="editing"/),
  header: classFrom(/<div class="(mb-4 flex items-end justify-between gap-3)"/),
  create: classFrom(/attr-href="basePath \+ '\/new'"[\s\S]*?class="([^"]+)"/),
  list: classFrom(/<ul class="([^"]+)" aria-label="Workspace connectors"/),
  row: classFrom(/<li class="([^"]+)"/),
  edit: classFrom(
    /class="([^"]+)"\s+attr-href="basePath \+ '\/' \+ encodeURIComponent\(item\.id\)"\s+attr-aria-label="'Edit/,
  ),
  remove: classFrom(/on-click="remove\(item\)"[\s\S]*?class="([^"]+)"/),
};

for (const viewport of [
  { name: "desktop", width: 1440, height: 900 },
  { name: "mobile", width: 390, height: 844 },
  { name: "narrow-mobile", width: 320, height: 720 },
]) {
  test(`connector list layout at ${viewport.name}`, async ({ page }, testInfo) => {
    await page.setViewportSize({ width: viewport.width, height: viewport.height });
    await page.goto("/tests/playwright/channel-harness.html");
    await page.setContent(`
      <main class="${classes.main}">
        <section data-testid="connector-card" class="${classes.card}">
          <div data-testid="connector-heading" class="${classes.header}">
            <h1 class="mt-1 text-lg font-semibold text-app-foreground">Connectors</h1>
            <a data-testid="new-connector" class="${classes.create}"><span aria-hidden="true">+</span> New connector</a>
          </div>
          <ul class="${classes.list}">
            ${["GitHub release", "Deploy to staging"]
              .map(
                (name) => `
              <li data-testid="connector-row" class="${classes.row}">
                <a class="min-w-0 flex-1 text-sm"><span class="truncate text-base font-semibold text-app-foreground">${name}</span></a>
                <span class="hidden text-xs text-app-secondary sm:inline">github-release · Enabled</span>
                <a data-testid="edit-connector" class="${classes.edit}">Edit</a>
                <button data-testid="delete-connector" class="${classes.remove}">Delete</button>
              </li>`,
              )
              .join("")}
          </ul>
        </section>
      </main>
    `);
    await page.addStyleTag({ url: "/ui/index.css" });

    const card = await page.locator('[data-testid="connector-card"]').boundingBox();
    const heading = await page.locator('[data-testid="connector-heading"]').boundingBox();
    const create = await page.locator('[data-testid="new-connector"]').boundingBox();
    const row = await page.locator('[data-testid="connector-row"]').first().boundingBox();
    const edit = await page.locator('[data-testid="edit-connector"]').first().boundingBox();
    const remove = await page.locator('[data-testid="delete-connector"]').first().boundingBox();
    expect(create.x + create.width).toBeCloseTo(heading.x + heading.width, 0);
    expect(Math.abs(edit.y + edit.height / 2 - (row.y + row.height / 2))).toBeLessThanOrEqual(1);
    expect(Math.abs(remove.y + remove.height / 2 - (row.y + row.height / 2))).toBeLessThanOrEqual(1);
    expect(remove.x).toBeGreaterThan(edit.x + edit.width);
    expect(await page.locator("body").evaluate((element) => element.scrollWidth)).toBeLessThanOrEqual(viewport.width);
    const editButton = page.locator('[data-testid="edit-connector"]').first();
    await editButton.hover();
    expect(await editButton.evaluate((element) => getComputedStyle(element).backgroundColor)).not.toBe(
      "rgba(0, 0, 0, 0)",
    );
    await expect(page.getByText("New connector")).toBeVisible();
    await page.screenshot({ path: testInfo.outputPath(`connector-list-${viewport.name}.png`), fullPage: true });
  });
}
