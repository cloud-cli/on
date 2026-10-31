import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(fileURLToPath(new URL("../../", import.meta.url)));
const report = {
  jobId: "nested-fixture",
  workflowName: "Nested recipe run",
  workflowId: "nested-recipe",
  status: "success",
  startedAt: "2026-01-01T12:00:00Z",
  durationMs: 12000,
  workerName: "fixture-worker",
  canViewLogs: true,
  canViewInputs: true,
  canViewArtifacts: false,
  canControl: false,
  inputs: { topSecretInput: "fixture-input-value" },
  steps: [
    {
      id: "parent",
      name: "Run recipe",
      status: "success",
      durationMs: 12000,
      logContent: "parent step output",
    },
    {
      id: "child",
      name: "Child deployment",
      status: "success",
      durationMs: 6000,
      logContent: "child step output",
    },
  ],
  callInstances: [
    {
      callId: "call-nested-1",
      target: "deploy-service@1.2.3",
      functionName: "deploy",
      status: "success",
      stepIds: ["child"],
      inputs: { nestedSecretInput: "nested-input-value" },
      outputs: { nestedOutput: "nested-output-value" },
    },
    {
      callId: "call-nested-2",
      target: "notify-operator@3.1.0",
      functionName: "notify",
      status: "failed",
      error: "Synthetic nested-call failure",
      stepIds: [],
      inputs: { incident: "fixture-incident" },
      outputs: {},
    },
  ],
};

const server = createServer(async (request, response) => {
  const url = new URL(request.url, "http://127.0.0.1");
  if (url.pathname === "/api/v1/auth/token") {
    response
      .writeHead(200, { "content-type": "application/json" })
      .end(JSON.stringify({ access_token: "fixture", expires_at: 4102444800000 }));
    return;
  }
  if (url.pathname === "/api/v1/events") {
    response.writeHead(200, {
      "content-type": "text/event-stream",
      "cache-control": "no-cache",
      connection: "keep-alive",
    });
    response.write(": fixture ready\n\n");
    return;
  }
  if (url.pathname === "/assets/service-worker.js") {
    response
      .writeHead(200, {
        "content-type": "text/javascript; charset=utf-8",
        "service-worker-allowed": "/ui/",
      })
      .end("self.addEventListener('fetch', () => {});");
    return;
  }
  if (url.pathname.startsWith("/api/v1/runs/")) {
    const visibility = url.pathname.split("/").pop();
    const accessReport = {
      ...report,
      jobId: visibility === "unknown-completion" ? "unknown-completion" : report.jobId,
      status: visibility === "unknown-completion" ? "failed" : report.status,
      canViewInputs: visibility !== "logs-only",
      canViewLogs: visibility !== "inputs-only",
    };
    response.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify(accessReport));
    return;
  }
  if (url.pathname === `/api/v1/jobs/${report.jobId}/step-attempts`) {
    response.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({ attempts: [] }));
    return;
  }
  if (url.pathname === "/api/v1/jobs/unknown-completion/step-attempts") {
    response
      .writeHead(200, { "content-type": "application/json" })
      .end(JSON.stringify({ attempts: [{ step_id: "parent", attempt: 1, status: "interrupted_or_unknown" }] }));
    return;
  }
  let file;
  if (url.pathname === "/assets/on.css") {
    file = resolve(root, "dist/on.css");
  } else if (
    [`/ui/runs/${report.jobId}`, "/ui/runs/logs-only", "/ui/runs/inputs-only", "/ui/runs/unknown-completion"].includes(
      url.pathname,
    )
  ) {
    file = "ui/run.html";
  } else if (url.pathname.startsWith("/assets/")) {
    file = resolve(root, "ui", url.pathname.slice("/assets/".length));
    if (!file.startsWith(resolve(root, "ui") + "/")) {
      response.writeHead(403).end();
      return;
    }
  }
  if (file) {
    try {
      const content = await readFile(file.startsWith("/") ? file : resolve(root, file));
      const type = file.endsWith(".mjs") ? "text/javascript" : file.endsWith(".css") ? "text/css" : "text/html";
      response.writeHead(200, { "content-type": `${type}; charset=utf-8` }).end(content);
    } catch {
      response.writeHead(404).end("Not found");
    }
    return;
  }
  response.writeHead(404).end("Not found");
});

const port = Number(process.env.RUN_DETAIL_PORT || 0);
server.listen(port, "127.0.0.1", () => {
  console.log(`Run detail fixture listening on ${server.address().port}`);
});
