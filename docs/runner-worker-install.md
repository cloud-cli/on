# API-only worker image

The coordinator image remains `Dockerfile` and owns all database access. Build the runtime-neutral Node worker image separately:

```sh
docker build -f Dockerfile.worker -t on-runner:dev .
```

The worker has no `DATABASE_URL` and does not receive the coordinator database module or credentials. It enrolls once over HTTPS, stores the issued bearer credential in `$HOME/.config/on/runner-credential` with mode `0600`, then reconnects using that credential. The enrollment code is single-use and expires; do not put it in command-line arguments or commit it to configuration.

Configure these environment values through the deployment's secret mechanism:

- `RUNNER_SERVER_URL`: coordinator origin (HTTPS required except loopback development).
- `RUNNER_ENROLLMENT_CODE`: one-time enrollment code on first startup only.
- `RUNNER_NAME`: display name (optional; defaults to `node-runner`).
- `RUNNER_WORKERS`: maximum local concurrent jobs.
- `RUNNER_TAGS`: comma-separated scheduling labels.
- `RUNNER_TMP`: mounted workspace base directory.
- `RUNNER_UPDATE_ADAPTER=systemd-npm`: opt into individually requested, exact-version package updates on a systemd host.
- `RUNNER_UPDATE_INSTALL_DIR`: absolute npm global prefix (for the documented `/usr/bin/on` unit, set this to `/usr`).
- `RUNNER_UPDATE_SERVICE`: exact systemd unit to restart (for example `runner-worker.service`).

After first enrollment, remove the enrollment-code secret and preserve the runner credential volume. Deleting that credential requires a new enrollment after an administrator revokes the old runner. Never mount the coordinator database into the worker.

The image provides the Node execution adapter. Systemd transient-unit execution still requires a host-compatible runtime arrangement and privileges; use the host installation when the worker must call `systemd-run`. Do not grant a container the host systemd socket unless its isolation and privilege model has been explicitly reviewed.

The `systemd-npm` update adapter is opt-in and only advertises update capability when configured. An administrator can request one exact semantic version for one idle runner at a time. The runner installs `@cloud-cli/on@<version>` into the configured prefix, then restarts only the configured unit. Container, Kubernetes, bare-process, and Go-based updater adapters are not included; those runtimes should not advertise `updater` until an appropriate adapter is installed.

Build and verify the standalone artifact with `pnpm test:worker-artifact`. This check inspects emitted JavaScript for coordinator/database modules and starts the worker with `DATABASE_URL` absent.
