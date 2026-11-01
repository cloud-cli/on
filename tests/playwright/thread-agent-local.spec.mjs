import { test, expect } from "@playwright/test";
import { spawn } from "node:child_process";
import { DatabaseSync } from "node:sqlite";
import { createServer } from "node:net";
import { createServer as createHttpServer, request as httpRequest } from "node:http";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { startLocalOidcProvider } from "./local-oidc-provider.mjs";

test("local OIDC callback protects workspace APIs; Thread Agent consent is human-only", async ({ browser }) => {
  test.setTimeout(120_000);
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "on-local-thread-agent-"));
  let provider;
  let app;
  let mock;
  let proxy;
  let db;
  let appOrigin;
  let mockOrigin;
  let testWorkspace;
  let streamId;
  let threadId;
  let agentSubject;
  let humanContext;
  let agentContext;
  const browserContexts = [];
  const externalRequests = [];
  const mockRequests = [];
  try {
    provider = await startLocalOidcProvider();
    const mockServer = createHttpServer(async (request, response) => {
      const chunks = [];
      for await (const chunk of request) {
        chunks.push(chunk);
      }
      mockRequests.push(JSON.parse(Buffer.concat(chunks).toString("utf8")));
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify({ choices: [{ message: { role: "assistant", content: "Synthetic local reply" } }] }));
    });
    await new Promise((resolve, reject) => {
      mockServer.once("error", reject);
      mockServer.listen(0, "127.0.0.1", resolve);
    });
    mock = mockServer;
    mockOrigin = `http://127.0.0.1:${mock.address().port}/v1`;
    const appPort = await new Promise((resolve, reject) => {
      const server = createServer();
      server.once("error", reject);
      server.listen(0, "127.0.0.1", () => {
        const value = server.address().port;
        server.close((error) => (error ? reject(error) : resolve(value)));
      });
    });
    const proxyPort = await new Promise((resolve, reject) => {
      const server = createServer();
      server.once("error", reject);
      server.listen(0, "127.0.0.1", () => {
        const value = server.address().port;
        server.close((error) => (error ? reject(error) : resolve(value)));
      });
    });
    appOrigin = `http://127.0.0.1:${proxyPort}`;
    const databasePath = path.join(root, "fixture.sqlite");
    app = spawn(process.execPath, ["dist/on.js", "start-server"], {
      cwd: process.cwd(),
      env: {
        ...process.env,
        PORT: String(appPort),
        DATABASE_URL: new URL("../oidc-sqlite-adapter.mjs", import.meta.url).href,
        OIDC_TEST_DB_PATH: databasePath,
        OIDC_ISSUER: provider.origin,
        OIDC_CLIENT_ID: "local-client",
        OIDC_CLIENT_SECRET: "local-secret",
        OPENAI_API_URL: mockOrigin,
        OPENAI_API_MODEL: "local-model",
        OPENAI_API_KEY: "local-key",
        THREAD_AGENT_PROVIDER_NOTICE: "Synthetic Thread content is sent to local test provider.",
        NODE_TLS_REJECT_UNAUTHORIZED: "0",
      },
      stdio: "ignore",
    });
    let ready = false;
    for (let i = 0; i < 100; i++) {
      try {
        if ((await fetch(`http://127.0.0.1:${appPort}/api/v1`)).ok) {
          ready = true;
          break;
        }
      } catch {
        /* startup */
      }
      await delay(100);
    }
    expect(ready).toBe(true);
    const proxyServer = createHttpServer((request, response) => {
      const requestUrl = new URL(request.url, appOrigin);
      if (request.method === "GET" && requestUrl.pathname === "/__test/thread-agent") {
        response.writeHead(200, { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" });
        response.end(
          html(
            testWorkspace,
            streamId,
            threadId,
            agentSubject,
            "Synthetic Thread content is sent to local test provider.",
          ),
        );
        return;
      }
      const upstream = httpRequest(
        {
          hostname: "127.0.0.1",
          port: appPort,
          path: request.url,
          method: request.method,
          headers: { ...request.headers, host: request.headers.host },
        },
        (upstreamResponse) => {
          response.writeHead(upstreamResponse.statusCode || 502, upstreamResponse.headers);
          upstreamResponse.pipe(response);
        },
      );
      upstream.on("error", () => {
        response.writeHead(502).end();
      });
      request.pipe(upstream);
    });
    await new Promise((resolve, reject) => {
      proxyServer.once("error", reject);
      proxyServer.listen(proxyPort, "127.0.0.1", resolve);
    });
    proxy = proxyServer;
    db = new DatabaseSync(databasePath);
    db.exec("PRAGMA foreign_keys=ON");
    const workspace = `local-${Date.now()}`;
    testWorkspace = workspace;
    const agent = "agent_local";
    agentSubject = agent;
    db.prepare("INSERT INTO teams(id,name) VALUES (?,?)").run(workspace, "Synthetic workspace");
    db.prepare("INSERT INTO oidc_users(subject,name,kind) VALUES (?,?, 'human')").run("local-human", "Synthetic Human");
    db.prepare("INSERT INTO oidc_users(subject,name,kind) VALUES (?,?, 'agent')").run(agent, "Synthetic Thread Agent");
    for (const subject of ["local-human", agent]) {
      db.prepare("INSERT INTO team_members(team_id,subject,role) VALUES (?,?,'collaborator')").run(workspace, subject);
    }
    db.prepare(
      "INSERT INTO workspace_permission_overrides(team_id,subject,capability,effect,granted_by) VALUES (?,?,'threads.agent.manage','allow',?)",
    ).run(workspace, "local-human", "local-human");
    db.prepare(
      "INSERT INTO workspace_permission_overrides(team_id,subject,capability,effect,granted_by) VALUES (?,?,'threads.agent.manage','allow',?)",
    ).run(workspace, agent, "local-human");
    streamId = `stream-${Date.now()}`;
    threadId = `thread-${Date.now()}`;
    db.prepare("INSERT INTO channels(id,team_id,name) VALUES (?,?,?)").run(streamId, workspace, "Synthetic stream");
    db.prepare("INSERT INTO channel_threads(id,team_id,channel_id,title,created_by) VALUES (?,?,?,?,?)").run(
      threadId,
      workspace,
      streamId,
      "Synthetic thread",
      "local-human",
    );
    const otherStream = `other-stream-${Date.now()}`;
    const otherThread = `other-thread-${Date.now()}`;
    db.prepare("INSERT INTO channels(id,team_id,name) VALUES (?,?,?)").run(otherStream, workspace, "Other stream");
    db.prepare("INSERT INTO channel_threads(id,team_id,channel_id,title,created_by) VALUES (?,?,?,?,?)").run(
      otherThread,
      workspace,
      otherStream,
      "Other thread",
      "local-human",
    );
    db.prepare(
      "INSERT INTO channel_thread_messages(id,team_id,channel_id,thread_id,author,body_json) VALUES (?,?,?,?,?,?)",
    ).run(
      "other-thread-message",
      workspace,
      otherStream,
      otherThread,
      "local-human",
      JSON.stringify({ text: "other-thread-fixture" }),
    );
    db.close();
    db = undefined;
    const login = async (identity) => {
      const context = await browser.newContext({
        viewport: { width: 1280, height: 900 },
        ignoreHTTPSErrors: true,
      });
      browserContexts.push(context);
      context.on("request", (request) => {
        if (!new URL(request.url()).hostname.match(/^(127\.0\.0\.1|localhost)$/)) {
          externalRequests.push(request.url());
        }
      });
      await context.request.get(`${provider.origin}/identity?as=${identity}`);
      const page = await context.newPage();
      const errors = [];
      page.on("requestfailed", (request) => errors.push(`request-failed:${new URL(request.url()).pathname}`));
      page.on("console", (message) => {
        if (message.type() === "error") {
          errors.push(message.text());
        }
      });
      page.on("pageerror", (error) => errors.push(error.message));
      await page.goto(`${appOrigin}/auth/login?url=%2F__test%2Fthread-agent`);
      await expect(page)
        .toHaveURL(`${appOrigin}/__test/thread-agent`, { timeout: 30_000 })
        .catch(async () => {
          throw new Error(
            `Local OIDC login did not complete: ${page.url()} ${await page.title()} ${(await page.locator("body").innerText()).slice(0, 500)}`,
          );
        });
      return { context, page, errors };
    };
    humanContext = await login("human");
    await expect(humanContext.page.getByRole("heading", { name: "Thread Agent consent" })).toBeVisible();
    await expect(humanContext.page.getByLabel("Consent to enable Agent responses for this Thread")).not.toBeChecked();
    await expect(humanContext.page.getByLabel("Agent for this thread").locator("option")).toHaveCount(2);
    await expect(humanContext.page.locator("#notice")).toHaveText(
      "Synthetic Thread content is sent to local test provider.",
    );
    const base = `${appOrigin}/api/v1/streams/${streamId}/threads/${threadId}/agent-subscriptions`;
    const headers = { "X-Workspace-ID": workspace, Origin: appOrigin };
    const anonymousResponse = await fetch(base, { headers: { "X-Workspace-ID": workspace } });
    expect(anonymousResponse.status).toBe(401);
    const deniedWithoutConsent = await humanContext.page.request.post(base, {
      headers,
      data: { agentPrincipalId: agentSubject, consent: false },
    });
    expect(deniedWithoutConsent.status()).toBe(400);
    await humanContext.page.getByLabel("Agent for this thread").selectOption(agentSubject);
    await humanContext.page.getByLabel("Consent to enable Agent responses for this Thread").check();
    await humanContext.page.getByRole("button", { name: "Enable Agent" }).click();
    await expect(humanContext.page.locator("#status")).toContainText("Agent enabled");
    await humanContext.page.getByLabel("Thread message").fill("Bounded synthetic message");
    await humanContext.page.getByRole("button", { name: "Send message" }).click();
    await expect.poll(() => mockRequests.length, { timeout: 30_000 }).toBe(1);
    expect(mockRequests[0].model).toBe("local-model");
    expect(JSON.stringify(mockRequests[0])).toContain("Bounded synthetic message");
    expect(JSON.stringify(mockRequests[0])).not.toMatch(/local-human|agent_local_|other-thread-fixture/i);
    expect(mockRequests[0].tools).toBeUndefined();
    await expect(humanContext.page.getByText("Synthetic local reply")).toBeVisible({ timeout: 30_000 });
    await expect(humanContext.page.locator("#status")).toContainText("complete", { timeout: 30_000 });
    const stateResponse = await humanContext.page.request.get(base, { headers });
    expect(stateResponse.status()).toBe(200);
    const agentState = await stateResponse.json();
    expect(agentState.turns).toHaveLength(1);
    expect(agentState.turns[0]).toMatchObject({ status: "complete", replyMessageId: expect.any(String) });
    const messagesResponse = await humanContext.page.request.get(
      `${appOrigin}/api/v1/streams/${streamId}/threads/${threadId}/messages`,
      { headers },
    );
    expect(messagesResponse.status()).toBe(200);
    const messages = (await messagesResponse.json()).messages;
    expect(messages.find((message) => message.id === agentState.turns[0].replyMessageId)).toMatchObject({
      author: agentSubject,
      body: { text: "Synthetic local reply" },
    });
    await humanContext.page.screenshot({ path: "/tmp/opencode/thread-agent-local-desktop.png", fullPage: true });
    await humanContext.page.reload();
    await expect(humanContext.page.getByText("Synthetic local reply")).toBeVisible();
    await humanContext.page.setViewportSize({ width: 390, height: 844 });
    await humanContext.page.screenshot({ path: "/tmp/opencode/thread-agent-local-mobile.png", fullPage: true });
    const requestsBeforeDisable = mockRequests.length;
    await humanContext.page.getByRole("button", { name: "Disable Agent" }).click();
    await expect(humanContext.page.locator("#status")).toContainText("Agent disabled");
    await humanContext.page.getByLabel("Thread message").fill("Message after disable");
    await humanContext.page.getByRole("button", { name: "Send message" }).click();
    await expect(humanContext.page.getByText("Message after disable")).toBeVisible();
    await delay(2500);
    expect(mockRequests).toHaveLength(requestsBeforeDisable);
    agentContext = await login("agent");
    const agentAttempt = await agentContext.page.request.post(base, {
      headers,
      data: { agentPrincipalId: agentSubject, consent: true },
    });
    expect(agentAttempt.status()).toBe(403);
    expect(await agentAttempt.json()).toEqual({ error: "Only a human can consent to Thread Agent responses" });
    expect(externalRequests).toEqual([]);
    expect(humanContext.errors).toEqual([]);
    expect(agentContext.errors).toEqual([]);
  } finally {
    await Promise.all(browserContexts.map((context) => context.close()));
    db?.close();
    if (app && app.exitCode === null) {
      app.kill("SIGTERM");
      await Promise.race([
        new Promise((resolve) => app.once("exit", resolve)),
        delay(5000).then(() => app.kill("SIGKILL")),
      ]);
    }
    if (mock) {
      await new Promise((resolve) => mock.close(resolve));
    }
    if (proxy) {
      await new Promise((resolve) => proxy.close(resolve));
    }
    await provider?.close();
    fs.rmSync(root, { recursive: true, force: true });
  }
});

function html(workspace, stream, thread, agent, notice) {
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>Thread Agent consent</title>
  <style>
    :root { color-scheme: light; font: 16px/1.5 system-ui, sans-serif; color: #14231c; background: #f3f6f4; }
    * { box-sizing: border-box; }
    [hidden] { display: none !important; }
    body { margin: 0 auto; max-width: 760px; padding: clamp(16px, 4vw, 36px); }
    main { display: grid; gap: 20px; }
    h1 { margin: 0; font-size: clamp(1.5rem, 5vw, 2rem); }
    .card { display: grid; gap: 16px; padding: 20px; border: 1px solid #c8d5cd; border-radius: 14px; background: white; box-shadow: 0 4px 18px #14231c0b; }
    .notice { padding: 12px 14px; border-left: 4px solid #19744d; border-radius: 6px; background: #edf7f1; }
    .controls { display: grid; grid-template-columns: minmax(0,1fr) auto; gap: 14px; align-items: center; }
    label { display: grid; gap: 6px; font-weight: 600; }
    label.consent { display: flex; align-items: flex-start; gap: 10px; font-weight: 400; }
    select, textarea { width: 100%; min-width: 0; padding: 10px 12px; border: 1px solid #aabbb0; border-radius: 8px; background: white; font: inherit; }
    textarea { min-height: 92px; resize: vertical; }
    button { min-height: 42px; padding: 9px 14px; border: 1px solid #19744d; border-radius: 8px; background: #19744d; color: white; font: inherit; font-weight: 650; cursor: pointer; }
    button.secondary { background: white; color: #19744d; }
    button:disabled { opacity: .48; cursor: not-allowed; }
    .status { min-height: 24px; color: #375446; font-weight: 600; }
    .transcript { display: grid; gap: 8px; }
    .message { width: fit-content; max-width: 92%; padding: 10px 13px; border-radius: 12px; background: #edf2ee; overflow-wrap: anywhere; }
    .message.agent { margin-left: auto; background: #e6f4ec; }
    @media (max-width: 520px) { .card { padding: 16px; } .controls { grid-template-columns: 1fr; } button { width: 100%; } }
  </style>
</head>
<body>
  <main>
    <header><h1>Thread Agent consent</h1><p>Enable one workspace Agent to respond in this Thread.</p></header>
    <section class="card" aria-label="Thread Agent controls">
      <p id="notice" class="notice">${notice}</p>
      <label id="agent-label">Agent for this thread<select id="agent" aria-label="Agent for this thread"><option value="">Loading Agents…</option></select></label>
      <label id="consent-label" class="consent"><input id="consent" type="checkbox" aria-label="Consent to enable Agent responses for this Thread"><span>I understand and consent to sending bounded content from this Thread to the disclosed provider.</span></label>
      <div class="controls"><button id="enable" disabled>Enable Agent</button><button class="secondary" id="disable" hidden>Disable Agent</button></div>
      <div id="status" class="status" role="status"></div>
    </section>
    <section class="card" aria-label="Thread conversation">
      <h2>Thread messages</h2>
      <div id="reply" class="transcript" aria-live="polite"></div>
      <label>Thread message<textarea id="message" aria-label="Thread message" placeholder="Write a message in this Thread"></textarea></label>
      <button id="send">Send message</button>
    </section>
  </main>
  <script>
    const base='/api/v1/streams/${stream}/threads/${thread}';
    const headers={'X-Workspace-ID':'${workspace}'};
    const status=document.querySelector('#status'), reply=document.querySelector('#reply');
    const agentSelect=document.querySelector('#agent'), disable=document.querySelector('#disable');
    const enable=document.querySelector('#enable'), consentLabel=document.querySelector('#consent-label');
    let agentsLoaded=false;
    const refresh=async()=>{
      let response=await fetch(base+'/messages',{headers});
      if(!response.ok)throw Error('messages unavailable');
      let data=await response.json();
      reply.replaceChildren(...data.messages.map(message=>{
        const bubble=document.createElement('p');
        bubble.className='message'+(message.author==='${agent}'?' agent':'');
        bubble.textContent=message.body?.text||JSON.stringify(message.body);
        return bubble;
      }));
      response=await fetch(base+'/agent-subscriptions',{headers});
      if(!response.ok)throw Error('subscription unavailable');
      data=await response.json();
      document.querySelector('#notice').textContent=data.providerNotice;
      if(!agentsLoaded){
        agentSelect.replaceChildren(new Option('Select an Agent',''),...data.agents.map(item=>new Option(item.name,item.principalId)));
        agentsLoaded=true;
      }
      agentSelect.parentElement.hidden=Boolean(data.subscription);
      consentLabel.hidden=Boolean(data.subscription);
      enable.hidden=Boolean(data.subscription);
      disable.hidden=!data.subscription;
      if(!data.subscription){document.querySelector('#consent').checked=false;enable.disabled=true;}
      status.textContent=data.subscription?'Agent enabled'+(data.turns[0]?.status?' · '+data.turns[0].status:''):'Agent disabled';
    };
    document.querySelector('#consent').onchange=event=>document.querySelector('#enable').disabled=!event.target.checked||!agentSelect.value;
    agentSelect.onchange=()=>document.querySelector('#enable').disabled=!document.querySelector('#consent').checked||!agentSelect.value;
    document.querySelector('#enable').onclick=async()=>{
      const response=await fetch(base+'/agent-subscriptions',{method:'POST',headers:{...headers,'content-type':'application/json'},body:JSON.stringify({agentPrincipalId:agentSelect.value,consent:true})});
      if(!response.ok)throw Error('consent rejected');
      await refresh();
    };
    disable.onclick=async()=>{
      const response=await fetch(base+'/agent-subscriptions',{headers});
      const data=await response.json();
      await fetch(base+'/agent-subscriptions/'+data.subscription.id,{method:'DELETE',headers});
      await refresh();
    };
    document.querySelector('#send').onclick=async()=>{
      const response=await fetch(base+'/messages',{method:'POST',headers:{...headers,'content-type':'application/json'},body:JSON.stringify({body:{text:document.querySelector('#message').value}})});
      if(!response.ok)throw Error('message rejected');
      await refresh();
    };
    refresh();
    setInterval(()=>refresh().catch(()=>{}),500);
  </script>
</body>
</html>`;
}
