import { createServer } from "node:http";
import { loadConfig } from "./config.js";
import type { ServerOptions, WorkflowEvent } from "./types.js";
import { sendJson, readBody, asObject } from "./utils.js";
import { processEvent } from "./workflow.js";
import { spawn } from "node:child_process";
import { formatReportAsHTML, getReport } from "./reports.js";

export async function startDaemon(
  options: ServerOptions,
): Promise<ReturnType<typeof createServer> | null> {
  if (options.daemon) {
    const skipDaemon = process.argv
      .slice(1)
      .filter((arg) => arg !== "--daemon" && arg !== "-d");

    const args = process.execArgv.concat(skipDaemon);
    const child = spawn(process.execPath, args, {
      detached: true,
      stdio: "ignore",
    });

    console.log(child.pid);
    child.unref();
    return null;
  }

  const config = await loadConfig(options.configPath);
  const server = createServer(async (request, response) => {
    if (request.method === "GET" && request.url === "/health") {
      sendJson(response, 200, { status: "OK" });
      return;
    }

    if (request.method === "GET" && request.url?.startsWith("/reports/")) {
      const id = request.url.split("/reports/")[1];
      const report = await getReport(id);

      if (report) {
        response.writeHead(200, { "Content-Type": "text/html" });
        response.end(await formatReportAsHTML(report));
      } else {
        response.writeHead(404, { "Content-Type": "text/html" });
        response.end(await formatReportAsHTML(null));
      }
      return;
    }

    if (request.method !== "POST") {
      sendJson(response, 405, { error: "Only POST webhooks are supported." });
      return;
    }

    try {
      const source = request.url?.slice(1) || "";
      const body = Buffer.concat(await request.toArray()).toString();
      const eventBody = asObject<WorkflowEvent['event']>(JSON.parse(body || "{}"));
      const event: WorkflowEvent = { source, event: eventBody };
      const outputs = await processEvent(event, config);
      const logUrl = (id: string) =>
        new URL("/reports/" + id, `http://${request.headers.host}`);

      sendJson(response, 202, {
        id: outputs.id,
        logUrl: logUrl(outputs.id).href,
        parent: !outputs.parentId
          ? null
          : {
              id: outputs.parentId,
              logUrl: outputs.parentId
                ? logUrl(outputs.parentId).href
                : undefined,
            },
        children:
          outputs.children?.map((childId) => ({
            id: childId,
            logUrl: logUrl(childId).href,
          })) || [],
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : "Unknown error";
      console.error("Error processing webhook:", error);
      sendJson(response, 400, { error: message });
    }
  });

  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(options.port, options.host, () => resolve());
  });

  const address = server.address();
  if (address && typeof address === "object") {
    console.log(`Started on http://${address.address}:${address.port}`);
  }

  return server;
}
