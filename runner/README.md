# Go runner foundation

Independent API-only Go module. Build with `cd runner && go build -o on-runner .`; `CGO_ENABLED=0 GOOS=linux GOARCH=amd64 go build -o on-runner-linux-amd64 .` (also supports `arm64`).

`on-runner version` prints the binary version. `on-runner doctor [-config runner.json]` validates credentials and checks the authenticated runner update endpoint; it does **not** mutate runner capabilities or claim a job.

Configuration is JSON, for example:

```json
{ "coordinatorUrl": "https://ci.example.invalid", "credential": "<runner bearer credential>", "tags": ["linux"] }
```

The coordinator URL must be HTTPS except for `localhost`, `127.0.0.1`, or `::1`. Protect credentials using mode 0600. The credential read/write helpers use private permissions and atomic replacement.

This is only a transport/configuration foundation, not a workflow-compatible runner. The client has explicit authenticated heartbeat and lease-claim methods (including the 204 idle response), with a 10-second HTTP timeout, 1 MiB response bound, and redirects disabled. `doctor` uses the read-only update endpoint. It does not enroll, execute or report jobs, renew leases, stream events, or implement expressions, secrets, retries, containers, systemd, or self-update. Do not assign production workloads to it.
