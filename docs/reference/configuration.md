# Configuration and CLI reference

On is configured through CLI flags, environment variables, and an optional JavaScript `runner.config.mjs` file.
Keep credentials in a secret manager or a root-only service environment file, not in source control.

## Commands

| Command                            | Purpose                                                                | Database required?              |
| ---------------------------------- | ---------------------------------------------------------------------- | ------------------------------- |
| `on start-server`                  | Start the ingress, web app, and control-plane API.                     | Yes                             |
| `on start-scheduler`               | Dispatch published cron and solar triggers.                            | Yes                             |
| `on start-workers`                 | Start the API-only worker; it enrolls and connects to the coordinator. | No                              |
| `on start-workers-legacy`          | Start the legacy database-connected worker.                            | Yes; avoid for new deployments. |
| `on promote-admin --subject <sub>` | Promote an existing OIDC user to platform admin.                       | Yes                             |

`start-server` listens on `PORT` (default `11235`). Put it behind HTTPS when reachable outside loopback. The
server also serves the web interface and API; the scheduler and workers are separate processes.

## CLI options

```text
on <command> [--config <file>] [--database <module-url>] [--port <port>] [--workers <count>]
```

`--config` defaults to `./runner.config.mjs` or `RUNNER_CONFIG_FILE`. `--database`, `--port`, and `--workers`
override environment defaults. A config file can also set `database`, `port`, `workers`, `serverUrl`, `tags`,
`storagePath`, `env`, `plugins`, `oidc`, and `push`.

Example:

```js
export default {
  port: 11235,
  database: process.env.DATABASE_URL,
  serverUrl: "https://on.example.net",
  workers: 4,
  tags: ["linux", "docker"],
  storagePath: "/var/lib/on/workspaces",
};
```

The config is executable JavaScript loaded by Node. Only use configuration files you trust.

## Environment variables

### Control plane and scheduler

| Variable                   | Purpose                                                                                                               |
| -------------------------- | --------------------------------------------------------------------------------------------------------------------- |
| `DATABASE_URL`             | Required by the server, scheduler, and legacy worker. URL of an importable JavaScript database module, not a SQL DSN. |
| `PORT`                     | Ingress/API listen port. Default: `11235`.                                                                            |
| `RUNNER_SERVER_URL`        | Public coordinator origin used to construct run links and by workers. Set it to the HTTPS origin behind your proxy.   |
| `OIDC_ISSUER`              | OIDC issuer URL. Preferred over the legacy `RUNNER_OIDC_PROVIDER_URL`.                                                |
| `OIDC_CLIENT_ID`           | OIDC client ID; preferred over `RUNNER_OIDC_CLIENT_ID`.                                                               |
| `OIDC_CLIENT_SECRET`       | OIDC client secret; preferred over `RUNNER_OIDC_CLIENT_SECRET`.                                                       |
| `RUNNER_MASTER_KEY`        | Master key for encrypted workspace secrets. Use the systemd credential instead when available. Control plane only.    |
| `RUNNER_VAPID_PUBLIC_KEY`  | Optional Web Push public key.                                                                                         |
| `RUNNER_VAPID_PRIVATE_KEY` | Optional Web Push private key. Keep private; used with the public key.                                                |
| `RUNNER_VAPID_SUBJECT`     | Optional Web Push contact, such as `mailto:admin@example.net`.                                                        |
| `RUNNER_FILE_API_URL`      | Optional shared FileBin API base URL for artifact/cache storage.                                                      |
| `RUNNER_FILE_BIN`          | Optional FileBin bin ID; enables FileBin storage when set.                                                            |
| `RUNNER_FILE_PASSWORD`     | Optional FileBin password.                                                                                            |

The supplied server unit loads `/etc/on/credentials/on-master-key` as a systemd credential. Do not give the master
key, OIDC client secret, or `DATABASE_URL` to API-only workers.

### API-only runners

| Variable                    | Purpose                                                                                                  |
| --------------------------- | -------------------------------------------------------------------------------------------------------- |
| `RUNNER_SERVER_URL`         | Coordinator origin. HTTPS is required except for loopback development.                                   |
| `RUNNER_ENROLLMENT_CODE`    | Single-use, expiring enrollment code. Remove it after the first successful enrollment.                   |
| `RUNNER_CREDENTIAL_FILE`    | Persistent private file for the issued runner credential. Default: `$HOME/.config/on/runner-credential`. |
| `RUNNER_CREDENTIAL`         | Direct bearer credential override. Prefer the protected credential file.                                 |
| `RUNNER_NAME`               | Display name reported at enrollment. Default: `node-runner`.                                             |
| `RUNNER_WORKERS`            | Maximum concurrent jobs. Default: `5`; API worker concurrency is clamped to 1–100.                       |
| `RUNNER_TAGS`               | Comma-separated scheduling labels advertised by this runner.                                             |
| `RUNNER_TMP`                | Workspace directory on the worker. Default: `/tmp/workspaces`.                                           |
| `RUNNER_UPDATE_ADAPTER`     | Set to `systemd-npm` to opt into exact-version updates on a compatible systemd host.                     |
| `RUNNER_UPDATE_INSTALL_DIR` | Absolute npm prefix required by the `systemd-npm` updater.                                               |
| `RUNNER_UPDATE_SERVICE`     | Exact systemd service unit to restart for an opted-in update.                                            |

Workers are authorized by their issued runner credential and workspace grant. Labels are scheduling metadata, not
authorization. `start-workers` does not require `DATABASE_URL`.

## Configuration precedence

Values in `runner.config.mjs` take precedence over CLI values, which take precedence over environment defaults for
database, port, and worker count. OIDC values can be supplied as config fields or environment variables; the
unprefixed `OIDC_*` variables take precedence over their legacy `RUNNER_OIDC_*` aliases.

## Update policy

The optional `systemd-npm` runner updater accepts exact semantic versions and requires explicit install-directory
and service-unit settings. The bundled `runner-worker-update.timer` is a separate package-update mechanism that
installs a moving `@latest` tag; do not enable it for a pinned/canary rollout without first reviewing its policy.
