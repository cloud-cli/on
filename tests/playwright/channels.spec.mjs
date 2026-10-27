import { expect, test } from "@playwright/test";

for (const viewport of [
  { name: "desktop", width: 1280, height: 900 },
  { name: "mobile", width: 390, height: 844 },
]) {
  test(`channel conversation flow (${viewport.name})`, async ({ page }, testInfo) => {
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
    let threads = [];
    let threadMessages = [];
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
      } else if (url.pathname === "/api/v1/channels" && request.method() === "GET") {
        data = {
          canEdit: true,
          channels: [{ id: "chan-local", name: longName }],
        };
      } else if (url.pathname.endsWith("/threads") && request.method() === "GET") {
        data = { threads };
      } else if (url.pathname.includes("/threads/") && url.pathname.endsWith("/messages")) {
        if (request.method() === "GET") {
          data = { messages: threadMessages };
        } else {
          const body = JSON.parse(request.postData());
          const message = { id: "thread-message-1", author: "You", body: body.body, createdAt: "2026-01-01T00:02:00Z" };
          threadMessages = [...threadMessages, message];
          data = { message };
        }
      } else if (url.pathname.endsWith("/threads") && request.method() === "POST") {
        const body = JSON.parse(request.postData());
        const thread = { id: "thread-local", title: body.title };
        threads = [...threads, thread];
        data = { thread };
      } else if (url.pathname.endsWith("/messages") && request.method() === "GET") {
        const after = url.searchParams.get("after");
        const start = after ? messages.findIndex((message) => message.id === after) + 1 : 0;
        const page = messages.slice(start, start + 50);
        data = {
          messages: page,
          next: page.length === 50 ? page[page.length - 1].id : null,
        };
      } else if (url.pathname.endsWith("/messages") && request.method() === "POST") {
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
    await expect(page.getByRole("heading", { name: "Streams" })).toBeVisible();
    const channel = page.getByRole("button", { name: longName });
    await channel.click();
    await expect(channel).toHaveAttribute("aria-pressed", "true");
    await expect(page.getByText("Earlier message")).toBeVisible();
    await expect(page.locator("[data-message-id]")).toHaveCount(50);
    await page.getByLabel("New thread title").fill("Investigate incident");
    await page.getByRole("button", { name: "Create thread" }).click();
    await expect(page.getByRole("button", { name: "Investigate incident" })).toHaveAttribute("aria-pressed", "true");
    await page.getByLabel("Thread message JSON body").fill('{"text":"Investigating in the Thread"}');
    await page.getByRole("button", { name: "Reply" }).click();
    await expect(page.getByText("Investigating in the Thread")).toBeVisible();
    await expect.poll(() => page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
    await page.evaluate(() => document.documentElement.setAttribute("data-theme", "dark"));
    const colors = await page.locator('[data-message-id="m001"] pre').evaluate((node) => ({
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
          return channel <= 0.04045 ? channel / 12.92 : ((channel + 0.055) / 1.055) ** 2.4;
        });
      return channels[0] * 0.2126 + channels[1] * 0.7152 + channels[2] * 0.0722;
    };
    const luminances = [luminance(colors.foreground), luminance(colors.background)].sort((a, b) => b - a);
    expect((luminances[0] + 0.05) / (luminances[1] + 0.05)).toBeGreaterThanOrEqual(4.5);
    await page.evaluate(() => document.documentElement.setAttribute("data-theme", "light"));
    await page.getByRole("button", { name: "Check for new messages" }).click();
    await expect(page.locator("[data-message-id]")).toHaveCount(120);
    await expect(page.locator('[data-message-id="m120"]')).toHaveCount(1);
    await expect(page.getByRole("button", { name: "Load newer messages" })).toBeHidden();
    await expect(page.getByRole("button", { name: "Send message" })).toBeVisible();
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
      requests.filter(({ url }) => url.includes("/messages") && url.includes("after=m121")).length,
    ).toBeGreaterThan(0);
    expect(
      requests
        .filter(({ url }) => url.includes("/messages") && url.includes("after=m121"))
        .every(({ authorization }) => authorization === "Bearer local-test-token"),
    ).toBe(true);
    expect(requests.some(({ url }) => url.includes("/api/v1/channels/chan-local/messages"))).toBe(true);

    await page.screenshot({
      path: testInfo.outputPath(`channels-${viewport.name}.png`),
      fullPage: true,
    });
    await page.locator("#channels").evaluate((element) => element.remove());
    await expect.poll(() => page.evaluate(() => window.__eventSources[0].closed)).toBe(true);
    expect(errors).toEqual([]);
  });
}

test("channel reconnect reconciles missed messages across pages without rerunning work", async ({ page }) => {
  const messages = Array.from({ length: 50 }, (_, index) => ({
    id: `m${String(index + 1).padStart(3, "0")}`,
    author: "Local member",
    createdAt: "2026-01-01T00:00:00Z",
    body: { text: `Message ${index + 1}` },
  }));
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
    const url = new URL(request.url());
    requests.push({ url: request.url(), method: request.method() });
    let data;
    if (url.pathname === "/api/v1/auth/token") {
      data = {
        access_token: "local-test-token",
        expires_at: Date.now() + 600_000,
      };
    } else if (url.pathname === "/api/v1/channels" && request.method() === "GET") {
      data = {
        canEdit: false,
        channels: [{ id: "chan-reconnect", name: "Reconnect" }],
      };
    } else if (url.pathname.endsWith("/messages") && request.method() === "GET") {
      const after = url.searchParams.get("after");
      const start = after ? messages.findIndex((message) => message.id === after) + 1 : 0;
      const pageMessages = messages.slice(start, start + 50);
      data = {
        messages: pageMessages,
        next: pageMessages.length === 50 ? pageMessages.at(-1).id : null,
      };
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
  await page.getByRole("button", { name: "Reconnect" }).click();
  await expect(page.locator("[data-message-id]")).toHaveCount(50);
  await expect.poll(() => page.evaluate(() => window.__eventSources.length)).toBe(1);

  await page.evaluate(() => window.__eventSources[0].dispatchEvent(new Event("error")));
  messages.push(
    ...Array.from({ length: 51 }, (_, index) => {
      const number = index + 51;
      return {
        id: `m${String(number).padStart(3, "0")}`,
        author: "Remote member",
        createdAt: "2026-01-01T00:01:00Z",
        body: { text: `Message ${number}` },
      };
    }),
  );
  await page.evaluate(() => window.__eventSources[0].dispatchEvent(new Event("open")));

  await expect(page.locator("[data-message-id]")).toHaveCount(101);
  for (let number = 1; number <= 101; number += 1) {
    const id = `m${String(number).padStart(3, "0")}`;
    await expect(page.locator(`[data-message-id="${id}"]`)).toHaveCount(1);
  }
  const reconciliationRequests = requests.filter(({ url }) => url.includes("/messages?"));
  expect(reconciliationRequests.map(({ url }) => new URL(url).searchParams.get("after"))).toContain("m050");
  expect(reconciliationRequests.map(({ url }) => new URL(url).searchParams.get("after"))).toContain("m100");
  expect(
    requests.some(({ url, method }) => method === "POST" || /\/workflows?\/|\/runs?\//.test(new URL(url).pathname)),
  ).toBe(false);
});

test("saved event history paginates safely and reloads without message notifications", async ({ page }) => {
  await page.setViewportSize({ width: 320, height: 844 });
  await page.addInitScript(() => localStorage.setItem("runner-team-id", "team-a"));
  const calls = [];
  await page.route("**/api/v1/**", async (route) => {
    const url = new URL(route.request().url());
    let data;
    if (url.pathname === "/api/v1/auth/token") {
      data = {
        access_token: "local-test-token",
        expires_at: Date.now() + 600000,
      };
    } else if (url.pathname === "/api/v1/channels") {
      data = { canEdit: false, channels: [{ id: "events", name: "Events" }] };
    } else if (url.pathname.endsWith("/messages")) {
      data = {
        messages: [
          {
            id: "linked-message",
            author: "Member",
            createdAt: "now",
            body: { text: "Linked content" },
          },
        ],
        next: null,
      };
    } else if (url.pathname.endsWith("/events")) {
      calls.push(url.searchParams.get("cursor"));
      data =
        calls.length === 1
          ? {
              events: [
                {
                  id: "e1",
                  type: "custom",
                  data: { text: { html: "<img src=x onerror=alert(1)>" } },
                  links: {
                    messageIds: ["linked-message"],
                    invocationIds: ["invoke-7"],
                    runIds: ["7"],
                    causationEventId: "cause-1",
                  },
                },
              ],
              nextCursor: "opaque +/cursor",
            }
          : {
              events: [{ id: "e2", type: "custom", data: { text: "second" } }],
              nextCursor: null,
            };
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
  await page.route("**/api/channels/**/events**", async (route) => {
    const url = new URL(route.request().url());
    const requestNumber = calls.length;
    calls.push(url.searchParams.get("cursor"));
    const data =
      requestNumber % 2 === 0
        ? {
            events: [
              {
                id: "e1",
                type: "custom",
                data: { text: { html: "<img src=x onerror=alert(1)>" } },
                links: {
                  messageIds: ["linked-message"],
                  invocationIds: ["invoke-7"],
                  runIds: ["7"],
                  causationEventId: "cause-1",
                },
              },
            ],
            nextCursor: "opaque +/cursor",
          }
        : {
            events: [{ id: "e2", type: "custom", data: { text: "second" } }],
            nextCursor: null,
          };
    await route.fulfill({
      contentType: "application/json",
      body: JSON.stringify(data),
    });
  });
  await page.goto("/tests/playwright/channel-harness.html");
  await page.getByRole("button", { name: "Events" }).click();
  const history = page.getByText("Event history", { exact: true });
  await expect(history).toBeVisible();
  await expect(page.getByText('"second"')).toHaveCount(0);
  await history.click();
  await expect(page.locator("[data-event-id=e1]")).toContainText("<img src=x onerror=alert(1)>");
  await expect(page.locator("[data-event-id=e1] img")).toHaveCount(0);
  await expect(page.getByRole("link", { name: "Message linked-message" })).toBeVisible();
  await page.getByRole("link", { name: "Message linked-message" }).click();
  await expect(page.locator('[data-message-id="linked-message"]')).toBeVisible();
  await expect(page.getByRole("link", { name: "Run 7" })).toHaveAttribute("href", "/ui/runs/7");
  await expect(page.getByRole("link", { name: "Invocation invoke-7" })).toHaveAttribute(
    "href",
    "/ui/workspaces/team-a/invocations/invoke-7",
  );
  await expect(page.getByRole("link", { name: "Caused by event cause-1" })).toBeVisible();
  await page.getByRole("button", { name: "Load more events" }).click();
  await expect(page.locator("[data-event-id]")).toHaveCount(2);
  expect(calls).toEqual([null, "opaque +/cursor"]);
  await page.getByRole("button", { name: "Reload history" }).click();
  await expect(page.locator("[data-event-id]")).toHaveCount(1);
  expect(calls).toEqual([null, "opaque +/cursor", null]);
  for (const viewport of [
    { width: 1280, height: 900, name: "desktop" },
    { width: 390, height: 844, name: "mobile" },
    { width: 320, height: 844, name: "narrow" },
  ]) {
    await page.setViewportSize({
      width: viewport.width,
      height: viewport.height,
    });
    await expect.poll(() => page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    await page.screenshot({
      path: test.info().outputPath(`channels-events-${viewport.name}.png`),
      fullPage: true,
    });
  }
});

test("Stream event notifications reconcile from the durable cursor without duplicate cards", async ({ page }) => {
  const cursors = [];
  await page.addInitScript(() => {
    window.__eventSources = [];
    window.EventSource = class extends EventTarget {
      constructor(url) {
        super();
        this.url = String(url);
        window.__eventSources.push(this);
      }
      close() {
        this.closed = true;
      }
    };
  });
  await page.route("**/api/v1/**", async (route) => {
    const url = new URL(route.request().url());
    let data;
    if (url.pathname === "/api/v1/auth/token") {
      data = { access_token: "local-test-token", expires_at: Date.now() + 600000 };
    } else if (url.pathname === "/api/v1/channels") {
      data = { canEdit: false, channels: [{ id: "live-stream", name: "Live" }] };
    } else if (url.pathname.endsWith("/messages")) {
      data = { messages: [], next: null };
    } else if (url.pathname.endsWith("/events")) {
      const cursor = url.searchParams.get("cursor");
      cursors.push(cursor);
      data =
        cursor === "cursor-e1"
          ? {
              events: [{ id: "event-2", type: "task.updated", data: { status: "done" } }],
              nextCursor: null,
              resumeCursor: "cursor-e2",
            }
          : {
              events: [{ id: "event-1", type: "task.created", data: { status: "queued" } }],
              nextCursor: null,
              resumeCursor: "cursor-e1",
            };
    } else {
      data = {};
    }
    await route.fulfill({ contentType: "application/json", body: JSON.stringify(data) });
  });
  await page.route("**/api/channels/**", async (route) => {
    const url = new URL(route.request().url());
    if (url.pathname.endsWith("/events")) {
      const cursor = url.searchParams.get("cursor");
      cursors.push(cursor);
      const data =
        cursor === "cursor-e1"
          ? {
              events: [{ id: "event-2", type: "task.updated", data: { status: "done" } }],
              nextCursor: null,
              resumeCursor: "cursor-e2",
            }
          : {
              events: [{ id: "event-1", type: "task.created", data: { status: "queued" } }],
              nextCursor: null,
              resumeCursor: "cursor-e1",
            };
      await route.fulfill({ contentType: "application/json", body: JSON.stringify(data) });
      return;
    }
    await route.fulfill({ contentType: "application/json", body: JSON.stringify({ messages: [], next: null }) });
  });
  await page.route("**/api/events**", async (route) => {
    await route.fulfill({ status: 204, body: "" });
  });
  await page.goto("/tests/playwright/channel-harness.html");
  await page.getByRole("button", { name: "Live" }).click();
  const history = page.getByText("Event history", { exact: true });
  await history.click();
  await expect(page.locator('[data-event-id="event-1"]')).toBeVisible();
  const eventSource = await page.evaluateHandle(() => window.__eventSources[0]);
  await eventSource.evaluate((source) => {
    source.dispatchEvent(
      new MessageEvent("channel.domain-event", { data: JSON.stringify({ channelId: "live-stream" }) }),
    );
  });
  await expect(page.locator('[data-event-id="event-2"]')).toBeVisible();
  await expect(page.locator('[data-event-id="event-1"]')).toHaveCount(1);
  expect(cursors).toEqual([null, "cursor-e1"]);
  expect(await eventSource.evaluate((source) => source.url)).toContain("/api/events");
});

test("revoked Stream history access clears saved events and linked runs on live refresh", async ({ page }) => {
  let denied = false;
  const historyRequests = [];
  const errors = [];
  const failedResponses = [];
  await page.addInitScript(() => {
    window.__eventSources = [];
    window.EventSource = class extends EventTarget {
      constructor(url) {
        super();
        this.url = String(url);
        window.__eventSources.push(this);
      }
      close() {
        this.closed = true;
      }
    };
  });
  page.on("console", (message) => {
    if (message.type() === "error") {
      errors.push(message.text());
    }
  });
  page.on("pageerror", (error) => errors.push(error.message));
  page.on("response", (response) => {
    if (response.status() >= 400 && !response.url().endsWith("/favicon.ico")) {
      failedResponses.push({ status: response.status(), url: response.url() });
    }
  });
  await page.route("**/api/v1/**", async (route) => {
    const url = new URL(route.request().url());
    if (url.pathname === "/api/v1/auth/token") {
      await route.fulfill({ json: { access_token: "local-test-token", expires_at: Date.now() + 600000 } });
    } else if (url.pathname === "/api/v1/channels") {
      await route.fulfill({ json: { canEdit: false, channels: [{ id: "revoked", name: "Revoked" }] } });
    } else if (url.pathname.endsWith("/threads")) {
      await route.fulfill({ json: { threads: [] } });
    } else if (url.pathname.endsWith("/messages")) {
      await route.fulfill({ json: { messages: [], next: null } });
    } else {
      await route.fulfill({ status: 404, json: { error: "Not found" } });
    }
  });
  await page.route("**/api/channels/**/events**", async (route) => {
    historyRequests.push(route.request().url());
    if (denied) {
      await route.fulfill({ status: 403, json: { error: "Forbidden" } });
      return;
    }
    await route.fulfill({
      json: {
        events: [
          {
            id: "protected-event",
            type: "workflow.completed",
            data: { status: "complete" },
            links: { runIds: ["private-run"] },
          },
        ],
        nextCursor: null,
        resumeCursor: "private-cursor",
      },
    });
  });
  await page.route("**/api/events**", async (route) => route.fulfill({ status: 204, body: "" }));

  await page.goto("/tests/playwright/channel-harness.html");
  await page.getByRole("button", { name: "Revoked" }).click();
  await page.getByText("Event history", { exact: true }).click();
  await expect(page.locator('[data-event-id="protected-event"]')).toBeVisible();
  await expect(page.getByRole("link", { name: "Run private-run" })).toBeVisible();

  denied = true;
  await page.evaluate(() => {
    window.__eventSources[0].dispatchEvent(
      new MessageEvent("channel.domain-event", { data: JSON.stringify({ channelId: "revoked" }) }),
    );
  });
  await expect(page.getByRole("alert")).toContainText("Forbidden");
  await expect(page.locator("[data-event-id]")).toHaveCount(0);
  await expect(page.getByRole("link", { name: "Run private-run" })).toHaveCount(0);
  expect(historyRequests).toHaveLength(2);
  expect(errors).toContain("Failed to load resource: the server responded with a status of 403 (Forbidden)");
  expect(failedResponses).toEqual([{ status: 403, url: expect.stringContaining("/api/channels/revoked/events") }]);
});

for (const viewport of [
  { name: "desktop", width: 1280, height: 900 },
  { name: "mobile", width: 390, height: 844 },
]) {
  test(`invocation view keeps admission and run state distinct (${viewport.name})`, async ({ page }, testInfo) => {
    await page.setViewportSize({ width: viewport.width, height: viewport.height });
    await page.addInitScript(() => {
      window.__eventSources = [];
      window.EventSource = class extends EventTarget {
        constructor(url) {
          super();
          this.url = String(url);
          window.__eventSources.push(this);
        }
        close() {
          this.closed = true;
        }
      };
    });
    const errors = [];
    page.on("console", (message) => {
      if (message.type() === "error") {
        errors.push(message.text());
      }
    });
    page.on("pageerror", (error) => errors.push(error.message));
    const runStatusRequests = [];
    await page.route("**/api/v1/**", async (route) => {
      const url = new URL(route.request().url());
      let data;
      if (url.pathname === "/api/v1/auth/token") {
        data = { access_token: "local-test-token", expires_at: Date.now() + 600000 };
      } else if (url.pathname === "/api/v1/workflow-invocations/invocation-1") {
        data = {
          id: "invocation-1",
          teamId: "team-a",
          requestEventId: "request-event-1",
          workflowId: "deploy",
          revision: 7,
          recordedAt: "2026-01-01T00:00:00.000Z",
          variants: [
            {
              variantIndex: 0,
              admissionStatus: "admitted",
              admissionOutcome: "accepted",
              errorCode: null,
              runId: "42",
            },
          ],
        };
      } else if (url.pathname === "/api/v1/runs/42") {
        runStatusRequests.push(route.request().headers()["x-team-id"]);
        data = { status: runStatusRequests.length === 1 ? "running" : "success", jobId: "42" };
      } else {
        await route.fulfill({
          status: 404,
          contentType: "application/json",
          body: JSON.stringify({ error: "Not found" }),
        });
        return;
      }
      await route.fulfill({ contentType: "application/json", body: JSON.stringify(data) });
    });

    await page.goto("/tests/playwright/invocation-harness.html?workspaceId=team-a&invocationId=invocation-1");
    await expect(page.getByRole("heading", { name: "Workflow invocation" })).toBeVisible();
    await expect(page.getByText("deploy @ revision 7")).toBeVisible();
    await expect(page.getByText("request-event-1")).toBeVisible();
    await expect(page.getByText("Admission: admitted")).toBeVisible();
    await expect(page.getByText("Decision: accepted")).toBeVisible();
    await expect(page.getByRole("link", { name: "Run 42" })).toHaveAttribute("href", "/ui/runs/42?workspaceId=team-a");
    await expect(page.getByText("Current run status: running")).toBeVisible();
    await page.evaluate(() => {
      window.__eventSources[0].dispatchEvent(
        new MessageEvent("jobs.changed", { data: JSON.stringify({ teamId: "team-a", jobId: 42 }) }),
      );
    });
    await expect(page.getByText("Current run status: success")).toBeVisible();
    expect(runStatusRequests).toEqual(["team-a", "team-a"]);
    expect(errors).toEqual([]);
    await page.screenshot({ path: testInfo.outputPath(`invocation-${viewport.name}.png`), fullPage: true });
  });
}

test("event history can retry initial and later-page failures without losing its cursor", async ({ page }) => {
  let initialAttempts = 0;
  let laterAttempts = 0;
  await page.route("**/api/v1/**", async (route) => {
    const url = new URL(route.request().url());
    if (url.pathname === "/api/v1/auth/token") {
      await route.fulfill({
        json: { access_token: "test", expires_at: Date.now() + 600000 },
      });
    } else if (url.pathname === "/api/v1/channels") {
      await route.fulfill({
        json: { canEdit: false, channels: [{ id: "retry", name: "Retry" }] },
      });
    } else if (url.pathname.endsWith("/messages")) {
      await route.fulfill({ json: { messages: [], next: null } });
    } else if (url.pathname.endsWith("/events")) {
      const cursor = url.searchParams.get("cursor");
      if (!cursor && initialAttempts++ === 0) {
        await route.fulfill({
          status: 503,
          json: { error: "Temporarily unavailable" },
        });
      } else if (!cursor) {
        await route.fulfill({
          json: {
            events: [{ id: "first", type: "saved" }],
            nextCursor: "opaque",
          },
        });
      } else if (laterAttempts++ === 0) {
        await route.fulfill({
          status: 503,
          json: { error: "Page unavailable" },
        });
      } else {
        await route.fulfill({
          json: { events: [{ id: "second", type: "saved" }], nextCursor: null },
        });
      }
    } else {
      await route.fulfill({ status: 404, json: { error: "Not found" } });
    }
  });
  await page.route("**/api/channels/*/events**", async (route) => {
    const url = new URL(route.request().url());
    const cursor = url.searchParams.get("cursor");
    if (!cursor && initialAttempts++ === 0) {
      await route.fulfill({
        status: 503,
        json: { error: "Temporarily unavailable" },
      });
    } else if (!cursor) {
      await route.fulfill({
        json: {
          events: [{ id: "first", type: "saved" }],
          nextCursor: "opaque",
        },
      });
    } else if (laterAttempts++ === 0) {
      await route.fulfill({ status: 503, json: { error: "Page unavailable" } });
    } else {
      await route.fulfill({
        json: { events: [{ id: "second", type: "saved" }], nextCursor: null },
      });
    }
  });
  await page.goto("/tests/playwright/channel-harness.html");
  await page.getByRole("button", { name: "Retry" }).click();
  const history = page.getByText("Event history", { exact: true });
  await history.click();
  await expect(page.getByRole("button", { name: "Retry loading events" })).toBeVisible();
  await page.getByRole("button", { name: "Retry loading events" }).click();
  await expect(page.locator('[data-event-id="first"]')).toBeVisible();
  await page.getByRole("button", { name: "Load more events" }).click();
  await expect(page.getByRole("button", { name: "Retry loading events" })).toBeVisible();
  await expect(page.locator('[data-event-id="first"]')).toBeVisible();
  await page.getByRole("button", { name: "Retry loading events" }).click();
  await expect(page.locator('[data-event-id="second"]')).toBeVisible();
  await expect(page.locator("[data-event-id]")).toHaveCount(2);
});

test("delayed event history response from a prior channel never leaks into the selection", async ({ page }) => {
  let releaseA;
  let startedA;
  const aStarted = new Promise((resolve) => {
    startedA = resolve;
  });
  await page.route("**/api/v1/**", async (route) => {
    const url = new URL(route.request().url());
    if (url.pathname === "/api/v1/auth/token") {
      await route.fulfill({
        json: { access_token: "test", expires_at: Date.now() + 600000 },
      });
    } else if (url.pathname === "/api/v1/channels") {
      await route.fulfill({
        json: {
          canEdit: false,
          channels: [
            { id: "A", name: "Channel A" },
            { id: "B", name: "Channel B" },
          ],
        },
      });
    } else if (url.pathname.endsWith("/messages")) {
      await route.fulfill({ json: { messages: [], next: null } });
    } else {
      await route.fulfill({ status: 404, json: { error: "Not found" } });
    }
  });
  await page.route("**/api/channels/*/events**", async (route) => {
    const channelId = new URL(route.request().url()).pathname.split("/").at(-2);
    if (channelId === "A") {
      startedA();
      await new Promise((resolve) => {
        releaseA = resolve;
      });
      await route.fulfill({
        json: { events: [{ id: "only-a", type: "saved" }], nextCursor: null },
      });
    } else {
      await route.fulfill({
        json: { events: [{ id: "only-b", type: "saved" }], nextCursor: null },
      });
    }
  });
  await page.goto("/tests/playwright/channel-harness.html");
  await page.getByRole("button", { name: "Channel A" }).click();
  await page.getByText("Event history", { exact: true }).click();
  await aStarted;
  await page.getByRole("button", { name: "Channel B" }).click();
  await page.getByText("Event history", { exact: true }).click();
  await expect(page.locator('[data-event-id="only-b"]')).toBeVisible();
  releaseA();
  await expect(page.locator('[data-event-id="only-a"]')).toHaveCount(0);
  await expect(page.locator('[data-event-id="only-b"]')).toBeVisible();
});
