import { expect, test } from "@playwright/test";

for (const viewport of [
  { name: "desktop", width: 1280, height: 900 },
  { name: "mobile", width: 390, height: 844 },
]) {
  test(`channel conversation flow (${viewport.name})`, async ({
    page,
  }, testInfo) => {
    await page.setViewportSize({
      width: viewport.width,
      height: viewport.height,
    });
    const errors = [];
    page.on("console", (message) => {
      if (message.type() === "error") {
        errors.push(message.text());
      }
    });
    page.on("pageerror", (error) => errors.push(error.message));

    let messages = Array.from({ length: 120 }, (_, index) => ({
      id: `m${String(index + 1).padStart(3, "0")}`,
      author: "Local member",
      createdAt: "2026-01-01T00:00:00Z",
      body: { text: index === 0 ? "Earlier message" : `Message ${index + 1}` },
    }));
    const longName = "x".repeat(120);
    const requests = [];
    await page.addInitScript(() => {
      window.__eventSources = [];
      window.EventSource = class extends EventTarget {
        constructor(url) {
          super();
          this.url = url;
          window.__eventSources.push(this);
        }
        close() {
          this.closed = true;
        }
      };
    });
    await page.route("**/api/v1/**", async (route) => {
      const request = route.request();
      requests.push({
        url: request.url(),
        method: request.method(),
        authorization: request.headers()["authorization"],
      });
      const url = new URL(request.url());
      let data;
      if (url.pathname === "/api/v1/auth/token") {
        data = {
          access_token: "local-test-token",
          expires_at: Date.now() + 600_000,
        };
      } else if (
        url.pathname === "/api/v1/channels" &&
        request.method() === "GET"
      ) {
        data = {
          canEdit: true,
          channels: [{ id: "chan-local", name: longName }],
        };
      } else if (
        url.pathname.endsWith("/messages") &&
        request.method() === "GET"
      ) {
        const after = url.searchParams.get("after");
        const start = after
          ? messages.findIndex((message) => message.id === after) + 1
          : 0;
        const page = messages.slice(start, start + 50);
        data = {
          messages: page,
          next: page.length === 50 ? page[page.length - 1].id : null,
        };
      } else if (
        url.pathname.endsWith("/messages") &&
        request.method() === "POST"
      ) {
        const body = JSON.parse(request.postData());
        const message = {
          id: "m121",
          author: "You",
          createdAt: "2026-01-01T00:01:00Z",
          body: body.body,
        };
        messages.push(message);
        data = { message };
      } else {
        await route.fulfill({
          status: 404,
          contentType: "application/json",
          body: JSON.stringify({ error: "Not found" }),
        });
        return;
      }
      await route.fulfill({
        contentType: "application/json",
        body: JSON.stringify(data),
      });
    });

    await page.goto("/tests/playwright/channel-harness.html");
    await expect(page.getByRole("heading", { name: "Channels" })).toBeVisible();
    const channel = page.getByRole("button", { name: longName });
    await channel.click();
    await expect(channel).toHaveAttribute("aria-pressed", "true");
    await expect(page.getByText("Earlier message")).toBeVisible();
    await expect(page.locator("[data-message-id]")).toHaveCount(50);
    await expect
      .poll(() =>
        page.evaluate(
          () => document.documentElement.scrollWidth <= window.innerWidth,
        ),
      )
      .toBe(true);
    await page.evaluate(() =>
      document.documentElement.setAttribute("data-theme", "dark"),
    );
    const colors = await page
      .locator('[data-message-id="m001"] pre')
      .evaluate((node) => ({
        foreground: getComputedStyle(node).color,
        background: getComputedStyle(node.parentElement).backgroundColor,
      }));
    const luminance = (color) => {
      const channels = color
        .match(/[\d.]+/g)
        .slice(0, 3)
        .map(Number)
        .map((value) => {
          const channel = value / 255;
          return channel <= 0.04045
            ? channel / 12.92
            : ((channel + 0.055) / 1.055) ** 2.4;
        });
      return channels[0] * 0.2126 + channels[1] * 0.7152 + channels[2] * 0.0722;
    };
    const luminances = [
      luminance(colors.foreground),
      luminance(colors.background),
    ].sort((a, b) => b - a);
    expect(
      (luminances[0] + 0.05) / (luminances[1] + 0.05),
    ).toBeGreaterThanOrEqual(4.5);
    await page.evaluate(() =>
      document.documentElement.setAttribute("data-theme", "light"),
    );
    await page.getByRole("button", { name: "Check for new messages" }).click();
    await expect(page.locator("[data-message-id]")).toHaveCount(120);
    await expect(page.locator('[data-message-id="m120"]')).toHaveCount(1);
    await expect(
      page.getByRole("button", { name: "Load newer messages" }),
    ).toBeHidden();
    await expect(
      page.getByRole("button", { name: "Send message" }),
    ).toBeVisible();
    await page.getByLabel("JSON message body").fill('{"text":"Sent locally"}');
    await page.getByRole("button", { name: "Send message" }).click();
    await expect(page.getByText("Sent locally")).toBeVisible();

    messages.push({
      id: "m122",
      author: "Remote member",
      createdAt: "2026-01-01T00:02:00Z",
      body: { text: "Received locally" },
    });
    await page.evaluate(() => {
      const event = new MessageEvent("channel.message", {
        data: JSON.stringify({ channelId: "chan-local" }),
      });
      window.__eventSources[0].dispatchEvent(event);
    });
    await expect(page.getByText("Received locally")).toBeVisible();
    await expect(page.locator("[data-message-id]")).toHaveCount(122);
    await expect(page.locator("[data-message-id]")).toHaveCount(122);
    await expect(page.locator('[data-message-id="m120"]')).toHaveCount(1);
    await expect(page.locator('[data-message-id="m121"]')).toHaveCount(1);
    await expect(page.locator('[data-message-id="m122"]')).toHaveCount(1);
    expect(
      requests.filter(
        ({ url }) => url.includes("/messages") && url.includes("after=m121"),
      ).length,
    ).toBeGreaterThan(0);
    expect(
      requests
        .filter(
          ({ url }) => url.includes("/messages") && url.includes("after=m121"),
        )
        .every(
          ({ authorization }) => authorization === "Bearer local-test-token",
        ),
    ).toBe(true);
    expect(
      requests.some(({ url }) =>
        url.includes("/api/v1/channels/chan-local/messages"),
      ),
    ).toBe(true);

    await page.screenshot({
      path: testInfo.outputPath(`channels-${viewport.name}.png`),
      fullPage: true,
    });
    await page.locator("#channels").evaluate((element) => element.remove());
    await expect
      .poll(() => page.evaluate(() => window.__eventSources[0].closed))
      .toBe(true);
    expect(errors).toEqual([]);
  });
}
