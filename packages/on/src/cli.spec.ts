import { test, expect, afterAll } from 'vitest';
import { createHmac, randomUUID } from 'node:crypto';
import { ChildProcess, spawn, spawnSync } from 'node:child_process';
import path from 'node:path';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import net, { AddressInfo } from 'node:net';
import { existsSync } from 'node:fs';

const WEBHOOKS_GITHUB_SECRET = 'github';
const processes = new Set<ChildProcess>();
const cliPath = path.resolve('./src/cli.ts');
const getPort = () =>
  new Promise<number>((resolve, reject) => {
    const server = net.createServer();
    server.listen(0, () => {
      const address = server.address() as AddressInfo;
      const port = address.port;
      server.close(() => resolve(port));
    });
    server.on('error', (err: Error) => reject(err));
  });

const startDaemon = async (options: { configPath?: string }) => {
  const port = await getPort();

  function sendEvent(event: any, headers = {}, path = '/') {
    return fetch(`http://127.0.0.1:${port}${path}`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        ...headers,
      },
      body: JSON.stringify(event),
    });
  }

  function stop() {
    return new Promise((resolve) => {
      server.on('exit', resolve);
      server.kill();
    });
  }

  const args = ['--import', 'tsx', cliPath, '--port', String(port), '--host', '127.0.0.1'];

  if (options.configPath) {
    args.push('--config', options.configPath);
  }

  const server = spawn(process.execPath, args, { stdio: 'inherit', env: { ...process.env, WEBHOOKS_GITHUB_SECRET } });

  processes.add(server);
  server.once('exit', () => processes.delete(server));
  server.stdout?.pipe(process.stdout);
  server.stderr?.pipe(process.stderr);

  await new Promise((resolve) => setTimeout(resolve, 1000));

  return { sendEvent, stop };
};

afterAll(() => {
  processes.forEach((proc) => proc.kill());
});

const getTempDir = () => mkdtemp(path.join(os.tmpdir(), 'on-workflow-test-'));
const cleanUp = (tempDir: string) => rm(tempDir, { recursive: true, force: true });

test('prints help', () => {
  const cwd = path.resolve('.');
  const args = ['--import', 'tsx', cliPath, '--help'];
  const result = spawnSync(process.execPath, args, {
    cwd,
    encoding: 'utf8',
  });

  expect(result.status).toBe(0);
  expect(result.stdout).toMatch(/daemonized webhook runner/);
});

test('executes workflow with mappings, secrets, env interpolation and defaults', { timeout: 30000 }, async () => {
  const tempDir = await getTempDir();
  const secretsPath = path.join(tempDir, '.env');
  const resultPath = path.join(tempDir, randomUUID() + '.txt');
  const configPath = path.join(tempDir, 'config.json');

  await writeFile(secretsPath, 'A_SECRET=top-secret\n');

  const config = {
    on: {
      'github.published': {
        runner: 'shell',
        secrets: [secretsPath],
        mappings: {
          url: 'inputs.package.package_version.package_url',
        },
        env: {
          A_SECRET: '${secrets.A_SECRET}',
          A_VALUE: '${inputs.image}',
          TMP: tempDir,
          RESULTS: resultPath,
        },
        defaults: {
          image: 'node:latest',
          args: [{ name: 'published' }],
        },
        steps: [
          'pwd',
          'echo ${inputs}',
          'echo ${env.A_SECRET} | tee -a ${env.RESULTS}',
          'echo ${inputs.url} | tee -a ${env.RESULTS}',
          'echo ${workflow.defaults.image} | tee -a ${env.RESULTS}',
          'cat ${env.RESULTS}',
        ],
      },
    },
  };

  await writeFile(configPath, JSON.stringify(config, null, 2));

  const event = {
    action: 'published',
    package: {
      package_version: {
        package_url: 'registry/image:v1',
      },
    },
  };

  const body = JSON.stringify(event);
  const headers = {
    'x-hub-signature': 'sha1=' + createHmac('sha1', WEBHOOKS_GITHUB_SECRET).update(body).digest('hex'),
  };
  const { sendEvent, stop } = await startDaemon({ configPath });
  const response = await sendEvent(event, headers, '/github');

  await stop();

  expect(response.ok).toBe(true);
  expect(response.status).toBe(202);

  expect(existsSync(resultPath)).toBe(true);
  const resultContents = (await readFile(resultPath, 'utf8')) as string;
  expect(resultContents).toContain('top-secret');
  expect(resultContents).toContain('registry/image:v1');
  expect(resultContents).toContain('node:latest');

  await cleanUp(tempDir);
});

test('stop workflow if one step fails', async () => {
  const tempDir = await getTempDir();
  const resultPath = path.join(tempDir, 'result.txt');
  const configPath = path.join(tempDir, 'config.json');

  const config = {
    on: {
      test: {
        runner: 'shell',
        steps: ['echo first > ${env.TMP}/result.txt', 'cat /not/existing', 'echo second > ${env.TMP}/result.txt'],
        env: { TMP: tempDir },
      },
    },
  };

  await writeFile(configPath, JSON.stringify(config, null, 2));

  const event = { test: {} };
  const { sendEvent, stop } = await startDaemon({ configPath });
  const response = await sendEvent(event, {}, '/test');

  await stop();

  expect(response.status).toBe(202);

  expect(existsSync(resultPath)).toBe(true);
  const resultContents = await readFile(resultPath, 'utf8');
  expect(resultContents).toContain('first');
  expect(resultContents).not.toContain('second');

  await cleanUp(tempDir);
});

test('skip workflow based on conditions', async () => {
  const tempDir = await getTempDir();
  const resultPath = path.join(tempDir, 'result.txt');
  const configPath = path.join(tempDir, 'config.json');

  const config = {
    on: {
      test: {
        runner: 'shell',
        if: ['${inputs.value} === 123 '],
        steps: [
          {
            run: 'echo works > result.txt',
            workingDir: tempDir,
          },
        ],
      },
    },
  };

  await writeFile(configPath, JSON.stringify(config, null, 2));

  const event = { test: { value: 456 } };
  const { sendEvent, stop } = await startDaemon({ configPath });
  const response = await sendEvent(event, {}, '/test');

  await stop();

  expect(response.status).toBe(202);
  expect(existsSync(resultPath)).toBe(false);

  await cleanUp(tempDir);
});

test('returns 202 for payloads that do not trigger any workflow', async () => {
  const { sendEvent, stop } = await startDaemon({ configPath: undefined });
  const response = await sendEvent({ wrong: true }, {}, '/null');

  await stop();

  expect(response.status).toBe(202);
});

test('converts objects to JSON when interpolating', async () => {
  const tempDir = await getTempDir();
  const resultPath = path.join(tempDir, 'result.txt');
  const configPath = path.join(tempDir, 'config.json');

  const config = {
    on: {
      test: {
        runner: 'shell',
        steps: ['echo ${inputs} > ${env.RESULTS}'],
        env: {
          RESULTS: resultPath,
        },
        defaults: {
          workingDir: tempDir,
        },
      },
    },
  };

  await writeFile(configPath, JSON.stringify(config, null, 2));

  const event = { test: { a: 1, b: [1, 2], c: { nested: true } } };
  const { sendEvent, stop } = await startDaemon({ configPath });
  const response = await sendEvent(event, {}, '/test');

  await stop();

  expect(response.status).toBe(202);

  expect(existsSync(resultPath)).toBe(true);
  const resultContents = (await readFile(resultPath, 'utf8')).trim();
  expect(resultContents).toBe(JSON.stringify(event));

  await cleanUp(tempDir);
});
