# Run an API worker in a container

The API-only Node worker can run from the standalone image built by this repository's `Dockerfile.worker`. It
does not import the coordinator's database client and does not need `DATABASE_URL`. Use the supplied systemd
worker unit on a host when workflows need systemd transient services.

## Build the image

From a checkout of the matching source revision:

```sh
docker build -f Dockerfile.worker -t on-runner:local .
```

Verify the standalone artifact before deployment:

```sh
pnpm test:worker-artifact
```

## Provide configuration and persistent state

Configure the worker with:

- `RUNNER_SERVER_URL`: the coordinator's public HTTPS origin (HTTP is accepted only for loopback development).
- `RUNNER_ENROLLMENT_CODE`: a one-time code created in the workspace's **Settings → Task Runners** page.
- `RUNNER_NAME`, `RUNNER_WORKERS`, and `RUNNER_TAGS`: name, concurrency, and scheduling labels.
- `RUNNER_TMP`: a mounted workspace directory.
- `RUNNER_CREDENTIAL_FILE`: a file in a persistent, private state mount.

For example, a container platform can mount persistent storage at `/runner-state` and provide
`RUNNER_CREDENTIAL_FILE=/runner-state/runner-credential`. Ensure that the mount is writable by the container's
runtime UID and that the credential remains a private regular file. Remove the enrollment code from the deployment
secret after the first successful enrollment. Preserve the credential volume across container replacement.

Run the image with a restart policy and inject credentials through your container platform's secret mechanism,
not a committed Compose file or image layer. The worker image is not a general-purpose sandbox: workflow commands
run inside its runtime unless you configure another driver. Do not mount the host's Docker socket, systemd socket,
database files, or other privileged host paths without an explicit isolation review.

## Runtime limitations

The container image provides the Node process execution adapter. It does not provide a supported containerized
systemd driver or automatic host integration. A workflow step using `image:` additionally needs a Docker CLI and
daemon accessible to the worker; granting that access changes the container's security boundary. Prefer a dedicated
host runner for systemd or Docker workloads, and give it only the workspace grants and labels it needs.
