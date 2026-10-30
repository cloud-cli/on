# Getting started: deploy On and connect a runner

This tutorial sets up a small self-hosted deployment with an HTTPS ingress/control plane, its scheduler, and one
workspace-scoped Linux runner. It assumes you have a Linux systemd host for the control plane, a separate or
co-located runner host, a public HTTPS hostname, an OIDC provider, and a compatible database module.

The HTTP server is both connector ingress and the web/API endpoint; it is not a separate ingress product. The
scheduler is a separate process. API-only runners connect to the server over HTTPS and do not receive the database
URL.

## 1. Prepare the database and hostname

`DATABASE_URL` is an importable JavaScript module URL, not a SQLite connection string. The module must export the
database methods `get`, `run`, `all`, and `exec`; the server also relies on database transactions for some updates.
Use a database service/module compatible with this interface, and take a backup before upgrading an existing
database. The control plane applies pending schema migrations when it starts.

Point a public hostname such as `on.example.net` at a reverse proxy that forwards requests to the control-plane
host on port `11235` (the default). Terminate TLS at the proxy and configure it to overwrite and forward the
original `Host` and `X-Forwarded-Proto: https` headers. Do not expose the service directly to the public internet
without HTTPS.

Register an OIDC client with this redirect URI:

```text
https://on.example.net/auth/callback
```

See [Configure OIDC sign-in](../how-to/configure-oidc.md) for provider and proxy details.

## 2. Install and configure the control plane

Install a released package version on the control-plane host. Pin the version you have tested:

```sh
sudo npm install --global --prefix /usr @cloud-cli/on@<version>
sudo install -d -m 0700 /opt/on /etc/on/credentials
```

Create a persistent master key for workspace secrets. Keep it private and back it up separately from the database:

```sh
sudo sh -c 'umask 077; test -e /etc/on/credentials/on-master-key || openssl rand -hex 32 > /etc/on/credentials/on-master-key'
```

Create `/etc/on/server.env` with owner-only permissions. Use your database module URL and OIDC client values:

```ini
DATABASE_URL=https://db.example.net/db~<database-id>/index.mjs
PORT=11235
RUNNER_SERVER_URL=https://on.example.net
OIDC_ISSUER=https://auth.example.net
OIDC_CLIENT_ID=<client-id>
OIDC_CLIENT_SECRET=<client-secret>
```

Create `/etc/on/scheduler.env` with the same database module URL:

```ini
DATABASE_URL=https://db.example.net/db~<database-id>/index.mjs
```

Keep both files root-readable only. Install the matching unit files from this repository's `systemd/` directory,
then start the control plane and scheduler:

```sh
sudo install -m 0644 systemd/runner-server.service systemd/runner-scheduler.service systemd/runner.target /etc/systemd/system/
sudo systemctl daemon-reload
sudo systemctl enable --now runner.target
```

`runner-server.service` loads the master key through a systemd credential. The server and scheduler need
`DATABASE_URL`; the server also needs the OIDC values to enable browser sign-in.

Check the services and public API:

```sh
sudo systemctl status runner-server.service runner-scheduler.service
curl -fsS https://on.example.net/api/v1 > /dev/null
```

Sign in at `https://on.example.net/ui/runs`. On first sign-in, create a workspace when prompted. The account that
creates it becomes that workspace's administrator.

## 3. Enroll a workspace runner

In the workspace, open **Settings → Task Runners → Activate runner**. Copy the one-time enrollment code; it expires
and cannot be viewed again.

On the runner host, install the same tested package version and create persistent directories:

```sh
sudo npm install --global --prefix /usr @cloud-cli/on@<version>
sudo install -d -m 0700 /opt/on /etc/on /var/lib/on
sudo install -d -m 0750 /var/lib/on/workspaces
```

Create `/etc/on/worker.env` as a root-owned mode-`0600` file:

```ini
RUNNER_SERVER_URL=https://on.example.net
RUNNER_NAME=linux-builder-01
RUNNER_TAGS=linux,docker
RUNNER_WORKERS=2
RUNNER_TMP=/var/lib/on/workspaces
RUNNER_CREDENTIAL_FILE=/var/lib/on/runner-credential
RUNNER_ENROLLMENT_CODE=<one-time-code>
```

`RUNNER_TAGS` are scheduling labels: a workflow requesting `tags: [linux, docker]` can run only on a runner
advertising both labels. Set labels to match the tools and trust level of that host. `RUNNER_WORKERS` controls local
concurrency.

Install and start the worker unit from the repository's `systemd/` directory:

```sh
sudo install -m 0644 systemd/runner-worker.service /etc/systemd/system/
sudo systemctl daemon-reload
sudo systemctl enable --now runner-worker.service
sudo journalctl -u runner-worker.service -n 50 --no-pager
```

On first start, the worker exchanges the one-time code and writes its bearer credential to the configured path
with owner-only permissions. Once the log confirms enrollment, remove the `RUNNER_ENROLLMENT_CODE` line from
`/etc/on/worker.env`. The worker keeps running, and subsequent restarts reuse the saved credential. Preserve that
credential file; deleting it requires a new enrollment after revoking the old runner.

The API worker does not need `DATABASE_URL`, `RUNNER_MASTER_KEY`, or the control plane's OIDC client secret. Do not
copy those values to runner hosts.

## 4. Create and run a workflow

Follow [Create and test a workflow](create-workflow.md). Use a `tags` list that matches the runner, save a draft,
and use **Run now** to test it. Publishing and enabling the workflow is required before connector or schedule
triggers can start new runs.

For external events, configure a workspace connector using the [connectors guide](../how-to/connectors.md).

## 5. Choose the right execution environment

The Node worker selects systemd transient services when systemd is available, otherwise it falls back to a
standard process driver. Systemd execution requires a compatible host with the necessary privileges; the supplied
systemd worker unit runs as root for this reason. Only run workflows you trust on that host. Steps using `image:`
also require a working Docker CLI and daemon on the runner.

The separate `Dockerfile.worker` builds an API-only worker image. It is suitable only when its runtime can provide
the execution features your workflows need; do not mount a host systemd socket or grant broad host privileges to
make a container behave like a systemd worker. See [Run an API worker in a container](../how-to/install-api-runner.md).
