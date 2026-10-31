import { expect, test } from "@playwright/test";

for (const viewport of [
  { width: 1280, height: 900 },
  { width: 390, height: 844 },
]) {
  test(`real nested-call run details at ${viewport.width}px`, async ({ page }, testInfo) => {
    const errors = [];
    const unexpectedRequests = [];
    page.on("pageerror", (error) => errors.push(error.message));
    page.on("console", (message) => {
      if (message.type() === "error") {
        errors.push(message.text());
      }
    });
    page.on("requestfailed", (request) => unexpectedRequests.push(`${request.url()} ${request.failure()?.errorText}`));
    page.on("request", (request) => {
      if (request.url().startsWith("blob:")) {
        return;
      }
      const url = new URL(request.url());
      if (
        url.hostname !== "127.0.0.1" &&
        !["at-li3.static.apphor.de", "esm.sh", "cdn.jsdelivr.net", "sodium.static.apphor.de", "unpkg.com"].includes(
          url.hostname,
        )
      ) {
        unexpectedRequests.push(request.url());
      }
    });
    await page.setViewportSize(viewport);
    await page.goto("/ui/runs/nested-fixture");
    await expect(page.getByRole("heading", { name: /Nested recipe run/ })).toBeVisible();
    const call = page.locator("summary", { hasText: "deploy-service@1.2.3" });
    await expect(call).toContainText("SUCCESS");
    await call.click();
    await expect(page.getByText("nested-input-value")).toBeVisible();
    await expect(page.getByText("nested-output-value")).toBeVisible();
    await page.getByRole("button", { name: "Child deployment, SUCCESS" }).click();
    await expect(page.locator(".log-panel h3")).toContainText("Child deployment");
    await expect(page.locator(".log-panel pre").first()).toContainText("child step output");
    const failedCall = page.locator("summary", { hasText: "notify-operator@3.1.0" });
    await expect(failedCall).toContainText("FAILED");
    await failedCall.click();
    await expect(page.getByText("Synthetic nested-call failure")).toBeVisible();
    expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(viewport.width);

    await page.reload();
    await expect(page.getByRole("heading", { name: /Nested recipe run/ })).toBeVisible();
    await expect(page.locator(".log-panel")).toBeVisible();
    await expect(page.getByRole("tab", { name: "Inputs" })).toBeVisible();
    await page.locator("summary", { hasText: "deploy-service@1.2.3" }).click();
    await page.screenshot({ path: testInfo.outputPath(`run-detail-${viewport.width}.png`), fullPage: true });
    expect(errors).toEqual([]);
    expect(unexpectedRequests).toEqual([]);
  });
}

for (const viewport of [
  { width: 1280, height: 900 },
  { width: 390, height: 844 },
]) {
  test(`unknown completion notice is careful and responsive at ${viewport.width}px`, async ({ page }, testInfo) => {
    const errors = [];
    page.on("pageerror", (error) => errors.push(error.message));
    page.on("console", (message) => {
      if (message.type() === "error") {
        errors.push(message.text());
      }
    });
    await page.setViewportSize(viewport);
    await page.goto("/ui/runs/unknown-completion");
    const notice = page.getByRole("status", { name: "Completion not recorded" });
    await expect(notice).toContainText("Completion was not recorded");
    await expect(notice).toContainText("The external outcome may be unknown");
    await expect(page.getByText("Attempt 1 · Completion not recorded")).toBeVisible();
    await expect(page.getByRole("button", { name: /replay|retry/i })).toHaveCount(0);
    await expect(page.getByRole("button", { name: "Restart run" })).toHaveCount(0);
    expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(viewport.width);
    await page.screenshot({ path: testInfo.outputPath(`unknown-completion-${viewport.width}.png`), fullPage: true });
    await page.goto("/ui/runs/logs-only");
    await expect(page.getByRole("status", { name: "Completion not recorded" })).toHaveCount(0);
    expect(errors).toEqual([]);
  });
}

test("input and log permissions are gated independently", async ({ page }) => {
  const errors = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await page.goto("/ui/runs/logs-only");
  await expect(page.getByRole("tab", { name: "Inputs" })).toHaveCount(0);
  await expect(page.locator(".log-panel")).toBeVisible();
  await page.goto("/ui/runs/inputs-only");
  await expect(page.getByRole("tab", { name: "Inputs" })).toBeVisible();
  await expect(page.locator(".log-panel")).toBeHidden();
  expect(errors).toEqual([]);
});
