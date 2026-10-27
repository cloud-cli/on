import { randomUUID } from "node:crypto";
import { createServer } from "node:net";
import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { setTimeout as delay } from "node:timers/promises";
import { test, expect } from "@playwright/test";

test.skip(!process.env.AUTH_AGENT_ID || !process.env.AUTH_AGENT_KEY, "requires documented Auth Agent test credentials");
test.setTimeout(150_000);

const authOrigin = "https://auth.api.apphor.de";
const playwrightOrigin = authOrigin;
const appHost = "127.0.0.1";
const unique = randomUUID();
const clientName = `on-v3-agent-e2e-${unique}`;
const appPort = await new Promise((resolve, reject) => {
  const server = createServer();
  server.once("error", reject);
  server.listen(0, appHost, () => {
    const address = server.address();
    server.close((error) => (error ? reject(error) : resolve(address.port)));
  });
});
const appOrigin = `http://${appHost}:${appPort}`;
const callbackUri = `${appOrigin}/auth/callback`;
const logoutUri = `${appOrigin}/ui/runs`;

let authSessionCookie;
let clientId;
let clientSecret;
let clientCreationAttempted = false;
let appProcess;
let appPortReady = false;
let temporaryRoot;
let databasePath;
let li3WebSource;

function findNested(value, predicate) {
  if (!value || typeof value !== "object") {
    return undefined;
  }
  if (predicate(value)) {
    return value;
  }
  for (const child of Object.values(value)) {
    const found = findNested(child, predicate);
    if (found) {
      return found;
    }
  }
  return undefined;
}

function cookiePair(setCookie, name) {
  const match = setCookie.match(new RegExp(`(?:^|,\\s*)${name}=([^;]+)`));
  return match ? `${name}=${match[1]}` : undefined;
}

async function createAgentSession() {
  const response = await fetch(`${authOrigin}/api/v1/agent/login`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Origin: playwrightOrigin },
    body: JSON.stringify({ agentId: process.env.AUTH_AGENT_ID, token: process.env.AUTH_AGENT_KEY }),
    redirect: "manual",
  });
  if (response.status !== 204) {
    throw new Error("Documented Auth Agent sign-in did not succeed");
  }
  const setCookie = response.headers.get("set-cookie") || "";
  authSessionCookie = cookiePair(setCookie, "connect.sid");
  if (!authSessionCookie) {
    throw new Error("Auth Agent sign-in did not return its session cookie");
  }
}

async function locateTemporaryClient() {
  if (clientId || !clientCreationAttempted) {
    return;
  }
  if (!authSessionCookie) {
    throw new Error("Temporary OIDC client may exist but the Auth session needed for lookup is unavailable");
  }
  const response = await fetch(`${authOrigin}/api/v1/oidc/apps`, {
    headers: { Origin: playwrightOrigin, Cookie: authSessionCookie },
  });
  if (!response.ok) {
    throw new Error(`Unable to locate the temporary OIDC client for cleanup (status ${response.status})`);
  }
  const payload = await response.json();
  const records = Array.isArray(payload) ? payload : payload.apps || payload.applications || [];
  const match = records.find((record) => record?.name === clientName);
  clientId = match?.id || match?.clientId;
}

async function cleanupTemporaryClient() {
  await locateTemporaryClient();
  if (!clientId) {
    if (clientCreationAttempted) {
      throw new Error("Temporary OIDC client may exist but could not be located for cleanup");
    }
    return;
  }
  if (!authSessionCookie) {
    throw new Error("Temporary OIDC client exists but the Auth session needed for cleanup is unavailable");
  }
  const response = await fetch(`${authOrigin}/api/v1/oidc/clients/${encodeURIComponent(clientId)}`, {
    method: "DELETE",
    headers: { Origin: playwrightOrigin, Cookie: authSessionCookie },
    redirect: "manual",
  });
  if (response.status !== 204) {
    throw new Error(`Temporary OIDC client cleanup failed with status ${response.status}`);
  }
  clientId = undefined;
  clientSecret = undefined;
  clientCreationAttempted = false;
}

async function createTemporaryClient() {
  let response;
  try {
    response = await fetch(`${authOrigin}/api/v1/oidc/clients`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Origin: playwrightOrigin, Cookie: authSessionCookie },
      body: JSON.stringify({
        name: clientName,
        redirectUris: [callbackUri],
        postLogoutRedirectUris: [logoutUri],
        scopes: ["openid", "profile", "email", "offline_access"],
        isPublic: false,
      }),
      redirect: "manual",
    });
  } catch (error) {
    clientCreationAttempted = true;
    throw error;
  }
  clientCreationAttempted = response.ok || response.status >= 300;
  const payload = await response.json().catch(() => ({}));
  const record = findNested(payload, (value) => value.name === clientName && (value.id || value.clientId)) || payload;
  clientId = record.id || record.clientId || record.client?.id || record.client?.clientId;
  clientSecret =
    record.secret || record.clientSecret || record.client?.secret || payload.secret || payload.clientSecret;
  if (response.status !== 201 || !clientId || typeof clientSecret !== "string" || !clientSecret) {
    await locateTemporaryClient();
    throw new Error("Auth did not create the temporary confidential OIDC client required for this test");
  }
}

async function startApplication() {
  const dbAdapter = new URL("../oidc-sqlite-adapter.mjs", import.meta.url).href;
  appProcess = spawn(process.execPath, ["dist/on.js", "start-server"], {
    cwd: process.cwd(),
    env: {
      ...process.env,
      PORT: String(appPort),
      DATABASE_URL: dbAdapter,
      OIDC_TEST_DB_PATH: databasePath,
      OIDC_ISSUER: authOrigin,
      OIDC_CLIENT_ID: clientId,
      OIDC_CLIENT_SECRET: clientSecret,
    },
    stdio: "ignore",
  });
  for (let attempt = 0; attempt < 100; attempt++) {
    if (appProcess.exitCode !== null) {
      throw new Error("Local OIDC test application exited during startup");
    }
    try {
      const response = await fetch(`${appOrigin}/api/v1`);
      if (response.ok) {
        appPortReady = true;
        return;
      }
    } catch {
      // The local server is still starting.
    }
    await delay(100);
  }
  throw new Error("Local OIDC test application did not become ready");
}

async function stopApplication() {
  if (!appProcess || appProcess.exitCode !== null) {
    return;
  }
  appProcess.kill("SIGTERM");
  await Promise.race([
    new Promise((resolve) => appProcess.once("exit", resolve)),
    delay(5000).then(() => {
      appProcess?.kill("SIGKILL");
    }),
  ]);
}

test.beforeAll(async () => {
  try {
    temporaryRoot = fs.mkdtempSync(path.join("/tmp/opencode", "on-oidc-agent-"));
    databasePath = path.join(temporaryRoot, "oidc.sqlite");
    const li3Response = await fetch("https://at-li3.static.apphor.de/web");
    if (!li3Response.ok) {
      throw new Error("LI3 browser runtime could not be fetched for the authenticated-shell test");
    }
    li3WebSource = await li3Response.text();
    await createAgentSession();
    await createTemporaryClient();
    await startApplication();
  } catch {
    try {
      await stopApplication();
      await cleanupTemporaryClient();
    } catch {
      throw new Error("OIDC test setup failed and temporary-client cleanup also failed");
    }
    throw new Error("OIDC Agent sign-in test setup failed");
  }
});

test.afterAll(async () => {
  let cleanupFailure;
  try {
    await cleanupTemporaryClient();
  } catch {
    cleanupFailure = new Error("Temporary OIDC client cleanup failed");
  } finally {
    await stopApplication();
    if (temporaryRoot) {
      fs.rmSync(temporaryRoot, { recursive: true, force: true });
    }
  }
  if (cleanupFailure) {
    throw cleanupFailure;
  }
});

test("Agent OIDC login, protected workspace shell, permissions, and logout", async ({ browser }) => {
  const context = await browser.newContext({ viewport: { width: 1280, height: 900 } });
  await context.route("https://at-li3.static.apphor.de/**", async (route) => {
    if (new URL(route.request().url()).pathname === "/web") {
      await route.fulfill({
        status: 200,
        contentType: "text/javascript; charset=utf-8",
        headers: { "access-control-allow-origin": "*" },
        body: li3WebSource,
      });
      return;
    }
    await route.continue();
  });
  const sessionCookie = authSessionCookie.split("=", 2)[1];
  await context.addCookies([
    {
      name: "connect.sid",
      value: sessionCookie,
      domain: "auth.api.apphor.de",
      path: "/",
      httpOnly: true,
      secure: true,
      sameSite: "Lax",
    },
  ]);
  const page = await context.newPage();
  const browserErrors = [];
  let agentWorkerListStatus;
  const cdp = await context.newCDPSession(page);
  await cdp.send("Network.enable");
  cdp.on("Network.requestWillBeSent", (event) => {
    const requestedUrl = new URL(event.request.url);
    if (requestedUrl.pathname.endsWith("/null")) {
      const initiatorFrame = event.initiator.stack?.callFrames?.[0];
      let initiator = event.initiator.type;
      if (initiatorFrame?.url) {
        const frameUrl = new URL(initiatorFrame.url);
        initiator = `${frameUrl.pathname}:${initiatorFrame.lineNumber + 1}:${initiatorFrame.columnNumber + 1}`;
      }
      const documentUrl = new URL(event.documentURL);
      browserErrors.push(`null-route-request:${event.type}:${documentUrl.pathname}:${initiator}`);
    }
  });
  page.on("console", (message) => {
    if (message.type() === "error") {
      const location = new URL(message.location().url || appOrigin);
      if (location.pathname === "/api/v1/workers") {
        browserErrors.push("agent-worker-list-console-error");
        return;
      }
      browserErrors.push(`console-error:${location.hostname}${location.pathname}`);
    }
  });
  page.on("pageerror", () => browserErrors.push("page-error"));
  page.on("requestfailed", (request) => {
    const location = new URL(request.url());
    browserErrors.push(`request-failed:${location.hostname}:${request.resourceType()}`);
  });
  page.on("response", (response) => {
    const pathname = new URL(response.url()).pathname;
    if (pathname === "/api/v1/workers") {
      agentWorkerListStatus = response.status();
    }
    if (pathname.endsWith("/null")) {
      browserErrors.push(`diagnostic-response:${pathname}:${response.status()}`);
    }
    if (response.status() >= 500 && !new URL(response.url()).pathname.endsWith("/auth/callback")) {
      browserErrors.push("unexpected-server-error");
    }
  });

  let stage = "oidc-login";
  try {
    await page.goto(`${appOrigin}/auth/login?url=%2Fui%2Fruns`);
    try {
      await page.waitForURL((url) => url.origin === appOrigin && url.pathname === "/ui/runs", { timeout: 60_000 });
    } catch {
      throw new Error("OIDC callback/state/PKCE flow did not return to the local application");
    }

    stage = "callback-state-rejection";
    const badCallback = await page.request.get(`${appOrigin}/auth/callback?code=invalid&state=tampered`);
    expect(badCallback.status()).toBe(502);

    stage = "authenticated-session";
    const sessionResponse = await page.request.get(`${appOrigin}/api/v1/auth/session`);
    expect(sessionResponse.status()).toBe(200);
    const session = await sessionResponse.json();
    expect(session).toMatchObject({ authenticated: true, user: { id: expect.any(String) } });

    const workspaceId = `oidc-test-${unique}`;
    const navigationWorkspaceId = `oidc-nav-${unique}`;
    const foreignWorkspaceId = `oidc-foreign-${unique}`;
    stage = "isolated-workspace-fixture";
    const fixtureDb = new DatabaseSync(databasePath);
    fixtureDb.exec("PRAGMA foreign_keys = ON");
    try {
      stage = "fixture-owner-workspace";
      const webhookToken = randomUUID();
      fixtureDb
        .prepare("INSERT INTO teams(id, name, webhook_token) VALUES (?, ?, ?)")
        .run(workspaceId, "OIDC Browser Fixture", webhookToken);
      stage = "fixture-owner-membership";
      fixtureDb
        .prepare("INSERT INTO team_members(team_id, subject, role) VALUES (?, ?, 'collaborator')")
        .run(workspaceId, session.user.id);
      fixtureDb
        .prepare("INSERT INTO teams(id, name, webhook_token) VALUES (?, ?, ?)")
        .run(navigationWorkspaceId, "Navigation Fixture", randomUUID());
      fixtureDb
        .prepare("INSERT INTO team_members(team_id, subject, role) VALUES (?, ?, 'collaborator')")
        .run(navigationWorkspaceId, session.user.id);
      stage = "fixture-foreign-workspace";
      fixtureDb
        .prepare("INSERT INTO teams(id, name, webhook_token) VALUES (?, ?, ?)")
        .run(foreignWorkspaceId, "Unrelated Fixture", randomUUID());
    } finally {
      fixtureDb.close();
    }

    stage = "workspace-authorization";
    const workspacesResponse = await page.request.get(`${appOrigin}/api/v1/workspaces`);
    expect(workspacesResponse.status()).toBe(200);
    const workspaces = await workspacesResponse.json();
    expect(workspaces.workspaces.some((workspace) => workspace.id === workspaceId)).toBe(true);
    expect(workspaces.workspaces.some((workspace) => workspace.id === foreignWorkspaceId)).toBe(false);

    stage = "permission-denial";
    const forbiddenMutation = await page.request.post(`${appOrigin}/api/v1/workspaces/${workspaceId}/invitations`, {
      data: { subject: "unauthorized-fixture-subject" },
    });
    expect(forbiddenMutation.status()).toBe(403);
    const foreignRead = await page.request.get(`${appOrigin}/api/v1/workspaces/${foreignWorkspaceId}/invitations`);
    expect([403, 404]).toContain(foreignRead.status());

    stage = "access-token-refresh-boundary";
    const accessTokenResponse = await page.request.get(`${appOrigin}/api/v1/auth/token`);
    expect(accessTokenResponse.status()).toBe(200);
    const tokenResponse = await accessTokenResponse.json();
    expect(tokenResponse).toMatchObject({ access_token: expect.any(String), token_type: "Bearer" });
    expect(Number(tokenResponse.expires_at)).toBeGreaterThan(Math.floor(Date.now() / 1000));

    stage = "authenticated-workspace-shell";
    const shellResponse = await page.goto(`${appOrigin}/ui/workspaces/${encodeURIComponent(workspaceId)}/runs`);
    expect(shellResponse?.status()).toBe(200);
    stage = "sidebar-layout-desktop";
    await expect(page.locator("[data-workspace-rail]")).toBeVisible();
    await expect(page.locator("#primary-sidebar")).toBeVisible();
    const searchPanelLayout = await page.evaluate(() => {
      const search = document.querySelector("[data-quick-switch-open]").getBoundingClientRect();
      const panel = document.querySelector("#main-content").closest("section").getBoundingClientRect();
      return { searchBottom: search.bottom, panelTop: panel.top };
    });
    expect(searchPanelLayout.searchBottom).toBeLessThan(searchPanelLayout.panelTop);
    const desktopGeometry = await page.evaluate(() => {
      const rect = (selector) => {
        const { x, y, width, height } = document.querySelector(selector).getBoundingClientRect();
        return { x, y, width, height };
      };
      return {
        rail: rect("[data-workspace-rail]"),
        navigation: rect("#primary-sidebar"),
        content: rect("#main-content"),
      };
    });
    expect(desktopGeometry.rail.x).toBeLessThan(desktopGeometry.navigation.x);
    expect(desktopGeometry.navigation.x).toBeLessThan(desktopGeometry.content.x);
    expect(desktopGeometry.rail.width).toBeCloseTo(64, 0);
    expect(desktopGeometry.navigation.width).toBeCloseTo(224, 0);
    stage = "workspace-switch-navigation-sync";
    const alternateWorkspace = page.getByRole("button", { name: "Switch to Navigation Fixture" });
    stage = "workspace-switch-alternate-present";
    await expect(alternateWorkspace).toHaveAttribute("aria-pressed", "false");
    stage = "workspace-switch-route-change";
    await alternateWorkspace.click();
    await expect(page).toHaveURL(new RegExp(`/ui/workspaces/${navigationWorkspaceId}/runs$`));
    stage = "workspace-switch-selected-button";
    await expect(alternateWorkspace).toHaveAttribute("aria-pressed", "true");
    stage = "workspace-switch-heading";
    const workspaceNavigation = page.getByRole("navigation", { name: "Workspace navigation" });
    await expect(workspaceNavigation.getByText("Navigation Fixture")).toBeVisible();
    stage = "workspace-switch-links";
    await expect(workspaceNavigation.getByRole("link", { name: "Runs" })).toHaveAttribute(
      "href",
      `/ui/workspaces/${navigationWorkspaceId}/runs`,
    );
    await page.getByRole("button", { name: "Switch to OIDC Browser Fixture" }).click();
    await expect(page).toHaveURL(new RegExp(`/ui/workspaces/${workspaceId}/runs$`));
    await expect(
      page.getByRole("navigation", { name: "Workspace navigation" }).getByText("OIDC Browser Fixture"),
    ).toBeVisible();
    stage = "authenticated-shell-profile";
    const profileButton = page.getByRole("link", { name: "Open preferences" });
    stage = "profile-button-visible";
    await expect(profileButton).toBeVisible();
    stage = "profile-button-shape";
    await expect(profileButton).toHaveClass(/rounded-sm/);
    stage = "theme-toggle-visible";
    await expect(
      page.locator(
        "[data-workspace-rail] button[aria-label^='Switch to light mode'], [data-workspace-rail] button[aria-label^='Switch to dark mode']",
      ),
    ).toBeVisible();
    stage = "workspace-button-native-popover";
    const workspaceNamePopover = page.locator(`[data-workspace-popover="${workspaceId}"]`);
    await expect(workspaceNamePopover).toBeVisible();
    await expect(workspaceNamePopover).toHaveText("OIDC Browser Fixture");
    stage = "quick-switch-template-rendering";
    await page.locator("[data-quick-switch-open]").click();
    const quickSwitchSearch = page.locator("[data-quick-switch-search]");
    await quickSwitchSearch.fill("OIDC Browser Fixture");
    await expect(page.getByRole("option").first()).toContainText("OIDC Browser Fixture");
    await page.screenshot({ path: "/tmp/opencode/oidc-quick-switch-desktop.png", fullPage: true });
    await page.setViewportSize({ width: 390, height: 844 });
    stage = "sidebar-layout-mobile-geometry";
    const mobileGeometry = await page.evaluate(() => {
      const rect = (selector) => {
        const { x, y, width, height } = document.querySelector(selector).getBoundingClientRect();
        return { x, y, width, height };
      };
      return {
        rail: rect("[data-workspace-rail]"),
        navigation: rect("#primary-sidebar"),
        content: rect("#main-content"),
      };
    });
    expect(mobileGeometry.rail.x).toBeLessThan(mobileGeometry.navigation.x);
    expect(mobileGeometry.navigation.y).toBeLessThan(mobileGeometry.content.y);
    expect(mobileGeometry.rail.width).toBeCloseTo(64, 0);
    stage = "sidebar-layout-narrow-overflow";
    await page.keyboard.press("Escape");
    await expect(page.locator("[data-quick-switch-overlay]")).toHaveCount(0);
    await page.setViewportSize({ width: 320, height: 720 });
    const narrowGeometry = await page.evaluate(() => {
      const sidebar = document.querySelector("#primary-sidebar");
      const overflows = [...document.querySelectorAll("body *")]
        .map((element) => {
          const rect = element.getBoundingClientRect();
          return {
            tag: element.tagName,
            id: element.id,
            className: String(element.className),
            right: Math.round(rect.right),
            position: getComputedStyle(element).position,
          };
        })
        .filter((element) => element.right > innerWidth)
        .slice(0, 5);
      return {
        viewport: innerWidth,
        documentWidth: document.documentElement.scrollWidth,
        sidebarWidth: sidebar.clientWidth,
        sidebarScrollWidth: sidebar.scrollWidth,
        overflows,
      };
    });
    await page.screenshot({ path: "/tmp/opencode/oidc-quick-switch-narrow.png", fullPage: true });
    stage = `sidebar-layout-narrow-overflow-${narrowGeometry.viewport}-${narrowGeometry.documentWidth}-${JSON.stringify(narrowGeometry.overflows)}`;
    expect(narrowGeometry.documentWidth).toBeLessThanOrEqual(narrowGeometry.viewport);
    expect(narrowGeometry.sidebarScrollWidth).toBeLessThanOrEqual(narrowGeometry.sidebarWidth);
    await page.setViewportSize({ width: 390, height: 844 });
    await page.screenshot({ path: "/tmp/opencode/oidc-quick-switch-mobile.png", fullPage: true });
    await page.setViewportSize({ width: 1280, height: 900 });
    await quickSwitchSearch.fill("no matching fixture destination");
    await expect(page.getByText("No matching destinations.")).toBeVisible();
    await quickSwitchSearch.fill("OIDC Browser Fixture");
    await page.keyboard.press("ArrowDown");
    await page.keyboard.press("Enter");
    await expect(page).toHaveURL(new RegExp(`/ui/workspaces/${workspaceId}/runs$`));
    stage = "private-data-masked-screenshots";
    await page.screenshot({ path: "/tmp/opencode/oidc-agent-desktop.png", fullPage: true });

    await page.setViewportSize({ width: 390, height: 844 });
    await page.screenshot({ path: "/tmp/opencode/oidc-agent-mobile.png", fullPage: true });

    stage = "logout-and-unauthorized-access";
    expect((await context.cookies(appOrigin)).some((cookie) => cookie.name === "runner_oidc_session")).toBe(true);
    const logoutResponse = await page.request.get(`${appOrigin}/auth/logout`, { maxRedirects: 0 });
    expect(logoutResponse.status()).toBe(302);
    const clearedCookie = (await logoutResponse.headers())["set-cookie"] || "";
    expect(clearedCookie.startsWith("runner_oidc_session=")).toBe(true);
    expect(clearedCookie).toContain("Max-Age=0");
    stage = "logout-cookie-cleared";
    expect((await context.cookies(appOrigin)).some((cookie) => cookie.name === "runner_oidc_session")).toBe(false);
    stage = "logout-session-invalidated";
    const loggedOutSession = await page.request.get(`${appOrigin}/api/v1/auth/session`);
    expect(loggedOutSession.status()).toBe(401);
    stage = "logout-protected-workspace-denied";
    const deniedAfterLogout = await page.request.get(`${appOrigin}/api/v1/workspaces`);
    expect(deniedAfterLogout.status()).toBe(401);
    stage = "browser-console-and-network";
    expect(agentWorkerListStatus).toBe(403);
    expect(browserErrors.filter((error) => error !== "agent-worker-list-console-error")).toEqual([]);
  } catch {
    const diagnostics = stage === "browser-console-and-network" ? ` (${browserErrors.join(",") || "unknown"})` : "";
    throw new Error(
      `Agent OIDC browser journey failed at ${stage}${diagnostics}; sensitive redirect and session values were suppressed`,
    );
  } finally {
    await context.close();
  }
});
