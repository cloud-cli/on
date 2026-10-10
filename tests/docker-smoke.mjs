import http from "node:http";
import os from "node:os";
import { execFileSync, spawn } from "node:child_process";

const dbPort = 18_888;
const appPort = 18_889;
const image = process.env.E2E_IMAGE || "on:e2e";
const containerName = "on-e2e-smoke";
const hostAddress =
  process.env.E2E_HOST_ADDRESS ||
  Object.values(os.networkInterfaces())
    .flatMap((addresses) => addresses || [])
    .find((address) => (address.family === "IPv4" || address.family === 4) && !address.internal)?.address;
let workflow;

if (!hostAddress) {
  throw new Error("Could not find a non-loopback IPv4 address reachable from the Docker bridge");
}

const database = http.createServer(async (request, response) => {
  let body = "";
  for await (const chunk of request) {
    body += chunk;
  }
  const query = JSON.parse(body || "{}");
  let result = query.m === "all" ? [] : query.m === "get" ? null : { changes: 1 };
  if (query.m === "get" && /COALESCE\(MAX\(revision\)/i.test(query.s)) {
    result = { revision: workflow ? 1 : 0 };
  }
  if (query.m === "get" && /FROM workflows WHERE id/i.test(query.s)) {
    result = workflow;
  }
  if (query.m === "get" && /MAX\(revision\)/i.test(query.s)) {
    result = { revision: 1 };
  }
  if (query.m === "run" && /INSERT INTO workflows/i.test(query.s)) {
    workflow = { id: query.d[0], name: query.d[1], source_yaml: query.d[2], enabled: query.d[3] };
  }
  if (query.m === "run" && /DELETE FROM workflows/i.test(query.s)) {
    workflow = null;
  }
  response.writeHead(200, { "content-type": "application/json" });
  response.end(JSON.stringify(result));
});

await new Promise((resolve) => database.listen(dbPort, hostAddress, resolve));

const containerArgs = [
  "run",
  "-d",
  "--rm",
  "--name",
  containerName,
  "-e",
  "RUNNER_ADMIN_SECRET=e2e-admin-secret",
  "-e",
  "DATABASE_URL=file:///home/app/e2e-db.mjs",
  "-e",
  `DATABASE_HTTP_URL=http://${hostAddress}:${dbPort}`,
  "-e",
  `PORT=${appPort}`,
  "-e",
  `RUNNER_SERVER_URL=http://127.0.0.1:${appPort}`,
  image,
  "dist/on.js",
  "start-server",
];
execFileSync("docker", containerArgs, { encoding: "utf8" });

const container = spawn("docker", ["logs", "--follow", containerName], {
  stdio: ["ignore", "pipe", "pipe"],
});
let containerOutput = "";
container.stdout.on("data", (chunk) => {
  containerOutput += chunk;
});
container.stderr.on("data", (chunk) => {
  containerOutput += chunk;
});

const stop = async () => {
  if (container.exitCode === null && container.signalCode === null) {
    container.kill("SIGTERM");
  }
  try {
    execFileSync("docker", ["rm", "-f", containerName], { stdio: "ignore" });
  } catch {}
};

const getAppBaseUrl = async () => {
  for (let attempt = 0; attempt < 40; attempt++) {
    if (container.exitCode !== null) {
      throw new Error(`Container exited before its IP was available\n${containerOutput}`);
    }
    try {
      const address = execFileSync(
        "docker",
        ["inspect", "--format", "{{range .NetworkSettings.Networks}}{{.IPAddress}}{{end}}", containerName],
        { encoding: "utf8" },
      ).trim();
      if (address) {
        return `http://${address}:${appPort}`;
      }
    } catch {}
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  throw new Error(`Unable to inspect the Docker container IP\n${containerOutput}`);
};

const waitForServer = async (appBaseUrl) => {
  for (let attempt = 0; attempt < 40; attempt++) {
    try {
      const response = await fetch(`${appBaseUrl}/on.css`);
      if (response.ok) {
        return;
      }
    } catch {}
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  throw new Error(`Container server did not become ready\n${containerOutput}`);
};

try {
  const appBaseUrl = await getAppBaseUrl();
  await waitForServer(appBaseUrl);

  const apiResponse = await fetch(`${appBaseUrl}/api`);
  if (apiResponse.status !== 401) {
    throw new Error(`Expected OpenAPI endpoint to require authentication, got ${apiResponse.status}`);
  }

  for (const path of ["/", "/runs", "/help", "/settings"]) {
    const response = await fetch(`${appBaseUrl}${path}`);
    const html = await response.text();
    if (response.status !== 503 || !html.includes("Sign-in is unavailable")) {
      throw new Error(`Expected ${path} to fail closed while OIDC is disabled, got ${response.status}`);
    }
  }

  const appCss = await fetch(`${appBaseUrl}/on.css`);
  const appCssText = await appCss.text();
  if (!appCss.ok || !appCssText.includes(".bg-flow-background")) {
    throw new Error("Tailwind application stylesheet failed");
  }

  for (const [path, expectedText] of [
    ["/app-icon.svg", "<svg"],
    ["/manifest.webmanifest", '"start_url":"/runs"'],
    ["/api-client.mjs", "loadToken"],
    ["/app-shell.mjs", "onInit"],
    ["/app-router.mjs", "navigateTo"],
    ["/dashboard.mjs", "refreshJobs"],
  ]) {
    const response = await fetch(`${appBaseUrl}${path}`);
    const content = await response.text();
    if (!response.ok || !content.includes(expectedText)) {
      throw new Error(`Bundled UI resource failed at ${path}: ${response.status}`);
    }
  }
} finally {
  await stop();
  database.close();
}
