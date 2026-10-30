import { expect, test } from "@playwright/test";

const templates = {
  connectorTemplates: [
    {
      namespace: "mock-team",
      slug: "deploy-hook",
      version: 3,
      name: "Deploy hook",
      description: "A fixture connector template.",
      sourceYaml: "name: deploy-hook\n",
    },
  ],
};
const recipes = {
  recipes: [
    {
      namespace: "mock-team",
      slug: "build",
      version: 1,
      name: "Build recipe",
      description: "Mock recipe",
      sourceYaml: "steps: []",
    },
  ],
};

async function setup(page, { delayedRecipes = false } = {}) {
  const errors = [];
  page.on("console", (message) => {
    if (message.type() === "error") {
      errors.push(`console: ${message.text()}`);
    }
  });
  page.on("pageerror", (error) => errors.push(`page: ${error.message}`));
  page.on("requestfailed", (request) => errors.push(`network: ${request.url()} ${request.failure()?.errorText}`));
  const installations = [];
  await page.route("**/api/v1/**", async (route) => {
    const request = route.request();
    const url = new URL(request.url());
    if (url.pathname === "/api/v1/auth/token") {
      await route.fulfill({
        json: {
          access_token: "fixture-token",
          expires_at: Date.now() + 3600000,
        },
      });
    } else if (url.pathname === "/api/v1/connector-templates") {
      await route.fulfill({ json: templates });
    } else if (url.pathname === "/api/v1/recipes") {
      if (delayedRecipes) {
        await new Promise((resolve) => setTimeout(resolve, 300));
      }
      await route.fulfill({ json: recipes });
    } else if (url.pathname === "/api/v1/workspaces") {
      await route.fulfill({
        json: {
          workspaces: [
            { id: "ws-one", name: "Workspace One" },
            { id: "ws-two", name: "Workspace Two" },
          ],
        },
      });
    } else if (url.pathname.endsWith("/install") && request.method() === "POST") {
      installations.push({ url: url.pathname, body: request.postDataJSON() });
      await route.fulfill({
        json: {
          url: "/hooks/fixture-key",
          signingSecret: "fixture-signing-secret",
        },
      });
    } else {
      errors.push(`unexpected API request: ${request.method()} ${url.pathname}`);
      await route.fulfill({
        status: 404,
        json: { error: "Unexpected fixture request" },
      });
    }
  });
  await page.goto("/tests/playwright/recipes-harness.html");
  return { errors, installations };
}

for (const viewport of [
  { name: "desktop", width: 1440, height: 900 },
  { name: "mobile", width: 390, height: 844 },
  { name: "narrow", width: 320, height: 720 },
]) {
  test(`connector template catalog renders without overflow at ${viewport.name}`, async ({ page }, testInfo) => {
    const { errors } = await setup(page);
    await page.setViewportSize({
      width: viewport.width,
      height: viewport.height,
    });
    await page.getByRole("button", { name: "Connector templates" }).click();
    await expect(page.getByRole("heading", { name: "Deploy hook" })).toBeVisible();
    await expect(page.locator("body").evaluate((el) => el.scrollWidth)).resolves.toBeLessThanOrEqual(viewport.width);
    await page.screenshot({
      path: testInfo.outputPath(`recipes-connectors-${viewport.name}.png`),
      fullPage: true,
    });
    expect(errors).toEqual([]);
  });
}

test("switching tabs ignores a delayed stale catalog response", async ({ page }) => {
  const { errors } = await setup(page, { delayedRecipes: true });
  await page.getByRole("button", { name: "Connector templates" }).click();
  await page.getByRole("button", { name: "Workflow recipes" }).click();
  await expect(page.getByRole("heading", { name: "Build recipe" })).toBeVisible();
  await page.getByRole("button", { name: "Connector templates" }).click();
  await expect(page.getByRole("heading", { name: "Deploy hook" })).toBeVisible();
  await expect(page.getByRole("heading", { name: "Build recipe" })).toHaveCount(0);
  expect(errors).toEqual([]);
});

test("installs into selected workspace and copies then clears one-time credentials", async ({ page, context }) => {
  const { errors, installations } = await setup(page);
  await page.getByRole("button", { name: "Connector templates" }).click();
  await page.getByRole("button", { name: "Install in workspace" }).click();
  await expect(page.getByRole("dialog", { name: "Install connector template" })).toBeVisible();
  await page.locator("[data-workspace]").selectOption("ws-two");
  await page.getByRole("dialog").getByRole("button", { name: "Install", exact: true }).click();
  await expect(page.getByRole("dialog", { name: "Connector installed" })).toBeVisible();
  expect(installations).toEqual([
    {
      url: "/api/v1/workspaces/ws-two/connector-templates/mock-team/deploy-hook/versions/3/install",
      body: {},
    },
  ]);
  const writes = [];
  await context.grantPermissions(["clipboard-read", "clipboard-write"]);
  await page.evaluate(() => navigator.clipboard.writeText(""));
  await page.getByRole("button", { name: "Copy webhook URL" }).click();
  await expect(page.locator("[data-url-copy-status]")).toHaveText(/copied/i);
  writes.push(await page.evaluate(() => navigator.clipboard.readText()));
  await page.getByRole("button", { name: "Copy signing secret" }).click();
  await expect(page.locator("[data-secret-copy-status]")).toHaveText(/copied/i);
  writes.push(await page.evaluate(() => navigator.clipboard.readText()));
  expect(writes).toEqual(["http://127.0.0.1:4179/hooks/fixture-key", "fixture-signing-secret"]);
  await page.getByRole("button", { name: /I saved these values/ }).click();
  await expect(page.locator("[data-secret-dialog]")).not.toHaveAttribute("open", "");
  await expect(page.locator("[data-secret-url]")).toHaveValue("");
  await expect(page.locator("[data-secret-value]")).toHaveValue("");
  expect(errors).toEqual([]);
});
