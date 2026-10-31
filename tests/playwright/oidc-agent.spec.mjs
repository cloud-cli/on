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
  const records = Array.isArray(payload) ? payload : payload.apps || payload.applications;
  if (!Array.isArray(records)) {
    throw new Error("Temporary OIDC client cleanup could not verify the applications response shape");
  }
  const match = records.find((record) => record?.name === clientName);
  const identifier = match?.id ?? match?.clientId;
  if (match && typeof identifier !== "string") {
    throw new Error("Temporary OIDC client cleanup could not verify a stable client identifier");
  }
  clientId = identifier;
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
  const verification = await fetch(`${authOrigin}/api/v1/oidc/apps`, {
    headers: { Origin: playwrightOrigin, Cookie: authSessionCookie },
  });
  if (!verification.ok) {
    throw new Error(`Temporary OIDC client cleanup could not be verified (status ${verification.status})`);
  }
  const payload = await verification.json();
  const records = Array.isArray(payload) ? payload : payload.apps || payload.applications;
  if (!Array.isArray(records)) {
    throw new Error("Temporary OIDC client cleanup response could not be verified");
  }
  if (records.some((record) => record?.id === clientId || record?.clientId === clientId)) {
    throw new Error("Temporary OIDC client remains after cleanup");
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
    } catch (cleanupError) {
      const detail = cleanupError instanceof Error ? cleanupError.message : "unknown cleanup error";
      throw new Error(`OIDC test setup failed and temporary-client cleanup also failed: ${detail}`);
    }
    throw new Error("OIDC Agent sign-in test setup failed");
  }
});

test.afterAll(async () => {
  let cleanupFailure;
  try {
    await cleanupTemporaryClient();
  } catch (error) {
    const detail = error instanceof Error ? error.message : "unknown cleanup error";
    cleanupFailure = new Error(`Temporary OIDC client cleanup failed: ${detail}`);
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
      fixtureDb.prepare("INSERT INTO teams(id, name) VALUES (?, ?)").run(workspaceId, "OIDC Browser Fixture");
      stage = "fixture-owner-membership";
      fixtureDb
        .prepare("INSERT INTO team_members(team_id, subject, role) VALUES (?, ?, 'admin')")
        .run(workspaceId, session.user.id);
      fixtureDb.prepare("INSERT INTO teams(id, name) VALUES (?, ?)").run(navigationWorkspaceId, "Navigation Fixture");
      fixtureDb
        .prepare("INSERT INTO team_members(team_id, subject, role) VALUES (?, ?, 'admin')")
        .run(navigationWorkspaceId, session.user.id);
      stage = "fixture-foreign-workspace";
      fixtureDb.prepare("INSERT INTO teams(id, name) VALUES (?, ?)").run(foreignWorkspaceId, "Unrelated Fixture");
    } finally {
      fixtureDb.close();
    }

    stage = "workspace-authorization";
    const workspacesResponse = await page.request.get(`${appOrigin}/api/v1/workspaces`);
    expect(workspacesResponse.status()).toBe(200);
    const workspaces = await workspacesResponse.json();
    expect(workspaces.workspaces.some((workspace) => workspace.id === workspaceId)).toBe(true);
    expect(workspaces.workspaces.some((workspace) => workspace.id === foreignWorkspaceId)).toBe(false);

    stage = "canonical-stream-thread-api";
    const streamsUrl = `${appOrigin}/api/v1/streams`;
    const workspaceHeaders = { "X-Workspace-ID": workspaceId, Origin: appOrigin };
    stage = "canonical-stream-list-status";
    let streamList = await page.request.get(streamsUrl, { headers: workspaceHeaders });
    expect(streamList.status()).toBe(200);
    stage = "canonical-stream-list-empty";
    expect((await streamList.json()).streams).toEqual([]);
    stage = "canonical-stream-create";
    const streamCreate = await page.request.post(streamsUrl, {
      headers: workspaceHeaders,
      data: { name: "Synthetic browser stream" },
    });
    expect(streamCreate.status()).toBe(201);
    const { stream } = await streamCreate.json();
    stage = "canonical-stream-contract";
    expect(stream).toMatchObject({ workspaceId, name: "Synthetic browser stream" });
    const threadUrl = `${streamsUrl}/${encodeURIComponent(stream.id)}/threads`;
    stage = "canonical-thread-create";
    const threadCreate = await page.request.post(threadUrl, {
      headers: workspaceHeaders,
      data: { title: "Synthetic discussion" },
    });
    expect(threadCreate.status()).toBe(201);
    const { thread } = await threadCreate.json();
    stage = "canonical-thread-contract";
    expect(thread).toMatchObject({ workspaceId, streamId: stream.id, title: "Synthetic discussion" });
    const messagesUrl = `${threadUrl}/${encodeURIComponent(thread.id)}/messages`;
    stage = "canonical-message-append";
    for (const text of ["First synthetic message", "Second synthetic message"]) {
      const appended = await page.request.post(messagesUrl, { headers: workspaceHeaders, data: { body: { text } } });
      expect(appended.status()).toBe(201);
    }
    stage = "canonical-message-page-one";
    const firstPage = await page.request.get(`${messagesUrl}?limit=1`, { headers: workspaceHeaders });
    expect(firstPage.status()).toBe(200);
    const pageOne = await firstPage.json();
    expect(pageOne.messages).toHaveLength(1);
    expect(pageOne.messages[0].body).toEqual({ text: "First synthetic message" });
    expect(pageOne.next).toBe(pageOne.messages[0].id);
    stage = "canonical-message-page-two";
    const secondPage = await page.request.get(`${messagesUrl}?limit=1&after=${encodeURIComponent(pageOne.next)}`, {
      headers: workspaceHeaders,
    });
    expect((await secondPage.json()).messages[0].body).toEqual({ text: "Second synthetic message" });
    stage = "canonical-stream-persisted";
    streamList = await page.request.get(streamsUrl, { headers: workspaceHeaders });
    expect((await streamList.json()).streams.map(({ id }) => id)).toContain(stream.id);
    stage = "canonical-thread-persisted";
    await page.reload();
    const persistedThreads = await page.request.get(threadUrl, { headers: workspaceHeaders });
    expect((await persistedThreads.json()).threads.map(({ id }) => id)).toContain(thread.id);
    const foreignStreamThreads = await page.request.get(`${streamsUrl}/${encodeURIComponent(stream.id)}/threads`, {
      headers: { "X-Workspace-ID": foreignWorkspaceId },
    });
    expect([403, 404]).toContain(foreignStreamThreads.status());
    stage = "canonical-message-foreign-workspace";
    const foreignMessages = await page.request.get(messagesUrl, { headers: { "X-Workspace-ID": foreignWorkspaceId } });
    expect([403, 404]).toContain(foreignMessages.status());

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
    stage = "authenticated-stream-history-view";
    const streamPage = await page.goto(
      `${appOrigin}/ui/workspaces/${encodeURIComponent(workspaceId)}/channels/${encodeURIComponent(stream.id)}`,
    );
    expect(streamPage?.status()).toBe(200);
    await expect(page.getByRole("heading", { name: "Synthetic browser stream" })).toBeVisible();
    const streamThreads = page.getByRole("list", { name: "Stream threads" });
    await expect(streamThreads).toContainText("First synthetic message");
    await streamThreads.getByRole("button", { name: "Synthetic discussion" }).click();
    await expect(page.getByRole("list", { name: "Thread messages" })).toContainText("Second synthetic message");
    const savedHistory = page.getByText("Event history", { exact: true });
    await expect(savedHistory).toBeVisible();
    await savedHistory.click();
    await expect(page.getByText("No saved events in this channel yet.")).toBeVisible();
    stage = "authenticated-workspace-shell";
    await page.goto(`${appOrigin}/ui/workspaces/${encodeURIComponent(workspaceId)}/runs`);
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
    const alternateWorkspace = page.getByRole("button", { name: "Navigation Fixture" });
    stage = "workspace-switch-alternate-present";
    await expect(alternateWorkspace).toHaveAttribute("aria-pressed", "false");
    stage = "workspace-switch-route-change";
    await alternateWorkspace.click();
    await expect(page).toHaveURL(new RegExp(`/ui/workspaces/${navigationWorkspaceId}/runs$`));
    stage = "workspace-switch-selected-button";
    await expect(alternateWorkspace).toHaveAttribute("aria-pressed", "true");
    stage = "workspace-switch-heading";
    const workspaceNavigation = page.getByRole("navigation", { name: "Global navigation" });
    await expect(page.getByRole("button", { name: "Navigation Fixture" })).toHaveAttribute("aria-pressed", "true");
    stage = "workspace-switch-links";
    await expect(workspaceNavigation.getByRole("link", { name: "Runs" })).toHaveAttribute(
      "href",
      `/ui/workspaces/${navigationWorkspaceId}/runs`,
    );
    await page.getByRole("button", { name: "OIDC Browser Fixture" }).click();
    await expect(page).toHaveURL(new RegExp(`/ui/workspaces/${workspaceId}/runs$`));
    await expect(page.getByRole("button", { name: "OIDC Browser Fixture" })).toHaveAttribute("aria-pressed", "true");
    stage = "authenticated-shell-profile";
    const profileButton = page.getByRole("link", { name: "Open preferences" });
    stage = "profile-button-visible";
    await expect(profileButton).toBeVisible();
    stage = "profile-button-shape";
    await expect(profileButton).toHaveClass(/rounded-full/);
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
    await page.keyboard.press("Control+k");
    const quickSwitchSearch = page.locator("[data-quick-switch-search]");
    await expect(quickSwitchSearch).toBeFocused();
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
    expect(mobileGeometry.rail.width).toBeCloseTo(390, 0);
    expect(mobileGeometry.rail.y).toBeLessThan(mobileGeometry.content.y);
    await expect(page.locator("#primary-sidebar")).toBeHidden();
    stage = "sidebar-layout-reference-width-619";
    await page.setViewportSize({ width: 619, height: 844 });
    await page.keyboard.press("Escape");
    await expect(page.locator("[data-quick-switch-overlay]")).toHaveCount(0);
    const referenceGeometry = await page.evaluate(() => ({
      viewport: innerWidth,
      documentWidth: document.documentElement.scrollWidth,
      contentWidth: document.querySelector("#main-content").getBoundingClientRect().width,
    }));
    expect(referenceGeometry.documentWidth).toBeLessThanOrEqual(referenceGeometry.viewport);
    expect(referenceGeometry.contentWidth).toBeGreaterThan(200);
    await page.screenshot({ path: "/tmp/opencode/oidc-sidebar-619.png", fullPage: true });
    stage = "sidebar-layout-narrow-overflow";
    await page.setViewportSize({ width: 320, height: 720 });
    const narrowMenuButton = page.locator("[data-nav-open]");
    await narrowMenuButton.click();
    await expect(narrowMenuButton).toHaveAttribute("aria-expanded", "true");
    await expect(page.locator("#primary-sidebar")).toBeVisible();
    const narrowGeometry = await page.evaluate(() => {
      const sidebar = document.querySelector("#primary-sidebar");
      const sidebarStyle = getComputedStyle(sidebar);
      const sidebarRect = sidebar.getBoundingClientRect();
      const sidebarDescendants = [...sidebar.querySelectorAll("*")].map((node) => {
        const rect = node.getBoundingClientRect();
        const style = getComputedStyle(node);
        return {
          tag: node.tagName,
          id: node.id,
          className: String(node.className),
          x: Math.round(rect.x),
          width: Math.round(rect.width),
          right: Math.round(rect.right),
          scrollWidth: node.scrollWidth,
          clientWidth: node.clientWidth,
          display: style.display,
          visibility: style.visibility,
          position: style.position,
          whiteSpace: style.whiteSpace,
        };
      });
      const overflowingSection = document.querySelector("#main-content")?.firstElementChild;
      const layoutChain = [];
      for (let node = overflowingSection; node && layoutChain.length < 8; node = node.parentElement) {
        const style = getComputedStyle(node);
        const rect = node.getBoundingClientRect();
        layoutChain.push({
          tag: node.tagName,
          id: node.id,
          className: String(node.className),
          x: Math.round(rect.x),
          width: Math.round(rect.width),
          scrollWidth: node.scrollWidth,
          display: style.display,
          minWidth: style.minWidth,
          maxWidth: style.maxWidth,
          gridColumns: style.gridTemplateColumns,
        });
      }
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
        sidebarRect: { x: sidebarRect.x, width: sidebarRect.width, right: sidebarRect.right },
        sidebarWidth: sidebar.clientWidth,
        sidebarScrollWidth: sidebar.scrollWidth,
        sidebarDisplay: sidebarStyle.display,
        sidebarVisibility: sidebarStyle.visibility,
        sidebarTransform: sidebarStyle.transform,
        sidebarDescendants,
        layoutChain,
        overflows,
      };
    });
    await page.screenshot({ path: "/tmp/opencode/oidc-quick-switch-narrow.png", fullPage: true });
    stage = `sidebar-layout-narrow-overflow-${narrowGeometry.viewport}-${narrowGeometry.documentWidth}-${JSON.stringify({ rect: narrowGeometry.sidebarRect, width: narrowGeometry.sidebarWidth, scrollWidth: narrowGeometry.sidebarScrollWidth, display: narrowGeometry.sidebarDisplay, visibility: narrowGeometry.sidebarVisibility, transform: narrowGeometry.sidebarTransform, descendants: narrowGeometry.sidebarDescendants })}-${JSON.stringify(narrowGeometry.layoutChain)}-${JSON.stringify(narrowGeometry.overflows)}`;
    expect(narrowGeometry.documentWidth).toBeLessThanOrEqual(narrowGeometry.viewport);
    expect(narrowGeometry.sidebarRect.x).toBeGreaterThanOrEqual(0);
    expect(narrowGeometry.sidebarRect.right).toBeLessThanOrEqual(narrowGeometry.viewport);
    expect(narrowGeometry.sidebarDisplay).not.toBe("none");
    expect(narrowGeometry.sidebarVisibility).toBe("visible");
    expect(narrowGeometry.sidebarScrollWidth).toBeLessThanOrEqual(narrowGeometry.sidebarWidth);
    await page.locator("[data-nav-close]").click();
    await expect(page.locator("[data-nav-open]")).toHaveAttribute("aria-expanded", "false");
    await page.setViewportSize({ width: 390, height: 844 });
    await page.screenshot({ path: "/tmp/opencode/oidc-quick-switch-mobile.png", fullPage: true });
    await page.setViewportSize({ width: 1280, height: 900 });
    await page.keyboard.press("Control+k");
    stage = "quick-switch-empty-results";
    await quickSwitchSearch.fill("");
    await quickSwitchSearch.pressSequentially("no matching fixture destination");
    await expect(page.getByRole("option")).toHaveCount(0);
    await quickSwitchSearch.fill("OIDC Browser Fixture");
    await expect(page.getByRole("option").first()).toContainText("OIDC Browser Fixture");
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
  } catch (error) {
    const diagnostics = stage === "browser-console-and-network" ? ` (${browserErrors.join(",") || "unknown"})` : "";
    const detail = error instanceof Error ? error.message : String(error);
    const sanitizedDetail = detail
      .replaceAll(process.env.AUTH_AGENT_KEY || "\0", "[redacted]")
      .replaceAll(clientSecret || "\0", "[redacted]")
      .replace(/https?:\/\/[^\s"'`]+/g, (value) => {
        try {
          const url = new URL(value);
          return `${url.origin}${url.pathname}`;
        } catch {
          return "[redacted-url]";
        }
      });
    throw new Error(`Agent OIDC browser journey failed at ${stage}${diagnostics}: ${sanitizedDetail}`);
  } finally {
    await context.close();
  }
});
