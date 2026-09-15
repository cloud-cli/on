import http from 'node:http';
import { spawn } from 'node:child_process';

const dbPort = 18_888;
const appPort = 18_889;
const image = process.env.E2E_IMAGE || 'on:e2e';
const containerName = 'on-e2e-smoke';
let workflow;

const database = http.createServer(async (request, response) => {
  let body = '';
  for await (const chunk of request) body += chunk;
  const query = JSON.parse(body || '{}');
  let result = query.m === 'all' ? [] : query.m === 'get' ? null : { changes: 1 };
  if (query.m === 'get' && /COALESCE\(MAX\(revision\)/i.test(query.s)) result = { revision: workflow ? 1 : 0 };
  if (query.m === 'get' && /FROM workflows WHERE id/i.test(query.s)) result = workflow;
  if (query.m === 'get' && /MAX\(revision\)/i.test(query.s)) result = { revision: 1 };
  if (query.m === 'run' && /INSERT INTO workflows/i.test(query.s)) {
    workflow = { id: query.d[0], name: query.d[1], source_yaml: query.d[2], enabled: query.d[3] };
  }
  if (query.m === 'run' && /DELETE FROM workflows/i.test(query.s)) workflow = null;
  response.writeHead(200, { 'content-type': 'application/json' });
  response.end(JSON.stringify(result));
});

await new Promise((resolve) => database.listen(dbPort, '127.0.0.1', resolve));

const container = spawn('docker', [
  'run', '--rm', '--name', containerName, '--network', 'host',
  '-e', 'RUNNER_ADMIN_SECRET=e2e-admin-secret',
  '-e', `RUNNER_DATABASE_URL=http://127.0.0.1:${dbPort}`,
  '-e', `PORT=${appPort}`,
  '-e', `RUNNER_SERVER_URL=http://127.0.0.1:${appPort}`,
  image, 'dist/on.js', 'start-server',
], { stdio: ['ignore', 'pipe', 'pipe'] });
let containerOutput = '';
container.stdout.on('data', (chunk) => { containerOutput += chunk; });
container.stderr.on('data', (chunk) => { containerOutput += chunk; });

const stop = async () => {
  if (container.exitCode === null) container.kill('SIGTERM');
  await new Promise((resolve) => setTimeout(resolve, 1000));
  spawn('docker', ['rm', '-f', containerName], { stdio: 'ignore' });
};

const waitForServer = async () => {
  for (let attempt = 0; attempt < 40; attempt++) {
    try {
      const response = await fetch(`http://127.0.0.1:${appPort}/api`);
      if (response.ok) return;
    } catch {}
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  throw new Error(`Container server did not become ready\n${containerOutput}`);
};

try {
  await waitForServer();

  const apiResponse = await fetch(`http://127.0.0.1:${appPort}/api`);
  const api = await apiResponse.json();
  if (api.openapi !== '3.0.3' || !api.paths['/api']) throw new Error('OpenAPI discovery endpoint failed');

  const protectedResponse = await fetch(`http://127.0.0.1:${appPort}/settings`);
  if (protectedResponse.status !== 401) throw new Error(`Expected protected Settings page, got ${protectedResponse.status}`);

  const authorization = `Basic ${Buffer.from('admin:e2e-admin-secret').toString('base64')}`;
  const settingsResponse = await fetch(`http://127.0.0.1:${appPort}/settings`, { headers: { authorization } });
  const settings = await settingsResponse.text();
  if (!settingsResponse.ok || !settings.includes('<app-router')) {
    throw new Error(`Authenticated Settings page failed: ${settingsResponse.status}\n${settings.slice(0, 300)}`);
  }
  const settingsPageResponse = await fetch(`http://127.0.0.1:${appPort}/pages/settings.html?page=tokens`, { headers: { authorization } });
  const settingsPage = await settingsPageResponse.text();
  if (!settingsPageResponse.ok || !settingsPage.includes('template component="page-settings"')) {
    throw new Error(`Settings page component failed: ${settingsPageResponse.status}\n${settingsPage.slice(0, 300)}`);
  }

  const workflowsResponse = await fetch(`http://127.0.0.1:${appPort}/workflows`, { headers: { authorization } });
  if (!workflowsResponse.ok) throw new Error(`Authenticated workflows page failed: ${workflowsResponse.status}`);

  const sourceYaml = 'name: E2E workflow\non:\n  generic: {}\nsteps:\n  - run: true\n';
  const validateResponse = await fetch(`http://127.0.0.1:${appPort}/api/workflows/validate`, {
    method: 'POST', headers: { authorization, 'content-type': 'application/json' }, body: JSON.stringify({ sourceYaml }),
  });
  if (!validateResponse.ok) throw new Error(`Workflow validation failed: ${validateResponse.status}`);
  const saveResponse = await fetch(`http://127.0.0.1:${appPort}/api/workflows/e2e-workflow`, {
    method: 'PUT', headers: { authorization, 'content-type': 'application/json' }, body: JSON.stringify({ sourceYaml }),
  });
  if (!saveResponse.ok) throw new Error(`Workflow save failed: ${saveResponse.status}`);
  const publishResponse = await fetch(`http://127.0.0.1:${appPort}/api/workflows/e2e-workflow/publish`, { method: 'POST', headers: { authorization } });
  if (!publishResponse.ok) throw new Error(`Workflow publish failed: ${publishResponse.status}`);
  const deleteResponse = await fetch(`http://127.0.0.1:${appPort}/api/workflows/e2e-workflow`, { method: 'DELETE', headers: { authorization } });
  if (deleteResponse.status !== 204) throw new Error(`Workflow delete failed: ${deleteResponse.status}`);
} finally {
  await stop();
  database.close();
}
