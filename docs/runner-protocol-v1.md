# Runner coordinator protocol v1 (design)

## Goals and boundary

- The coordinator is the only process with database credentials. Runners have no database URL, schema, or database client.
- Runner communication is language- and runtime-neutral: versioned JSON over HTTPS REST, plus an authenticated SSE stream for low-latency notifications.
- REST is authoritative. SSE is advisory; runners reconnect and reconcile through REST so transient events cannot lose work or updates.
- Execution/runtime is an adapter owned by the runner (systemd, Docker, Kubernetes, or bare process). The coordinator never invokes host-specific commands.
- Existing workflows/jobs remain compatible during migration. Legacy DB-connected workers remain supported until the API-only canary is proven.

## Runner identity and authorization

An operator creates an expiring, single-use enrollment code scoped as either `shared` or `team`. A runner exchanges it once and receives a stable server-issued `runnerId` and a unique revocable credential. Store enrollment and runner credentials only as hashes; display the enrollment code once. Do not place credentials in URLs or command history.

The coordinator records runtime, version, capabilities, configured labels, concurrency, status, and team grants. Labels/capabilities are scheduling metadata, not authorization. A shared runner is visible as available but receives no team's jobs until that team explicitly grants it access. A team-scoped runner is authorized only for its enrolled team. A team grant can be revoked without changing the runner's identity. Cross-team shared execution requires per-job isolation and workspace cleanup.

All endpoints below are under `/api/v1`. Runner endpoints require `Authorization: Bearer <runner credential>` and bind identity to that credential; never trust a runner ID or team ID supplied in a body/header as identity. Browser management endpoints require an authenticated administrator or team admin as appropriate, same-origin/CSRF protection, and audit records.

## Runner endpoints

| Method and path                           | Purpose                                                                                         |
| ----------------------------------------- | ----------------------------------------------------------------------------------------------- |
| `POST /runner-enrollments`                | Operator creates a short-lived single-use code with shared/team scope.                          |
| `POST /runners/enroll`                    | Runner exchanges the code for its stable identity and unique credential.                        |
| `GET /runner/events`                      | Authenticated SSE stream: `jobs.available`, `lease.cancelled`, `runner.drain`, `runner.update`. |
| `POST /runner/heartbeat`                  | Report health, version, capabilities, capacity, active leases, and update state.                |
| `POST /runner/leases`                     | Atomically claim one eligible job; return `204` when none is available.                         |
| `POST /runner/leases/{leaseId}/renew`     | Renew the active lease; reject expired or superseded leases.                                    |
| `GET /runner/leases/{leaseId}`            | Reconcile authoritative lease/cancellation state after reconnect.                               |
| `GET /runner/leases/{leaseId}/workflow`   | Fetch the immutable normalized workflow revision for this assignment.                           |
| `GET /runner/leases/{leaseId}/secrets`    | Fetch only secrets authorized for this active job assignment.                                   |
| `PUT /runner/leases/{leaseId}/report`     | Submit step/job reports; idempotent for a given lease and revision.                             |
| `POST /runner/leases/{leaseId}/logs`      | Upload bounded, sequenced log chunks.                                                           |
| `POST /runner/leases/{leaseId}/artifacts` | Upload job-scoped artifact metadata/content (or later exchange scoped object-store URLs).       |
| `POST /runner/leases/{leaseId}/complete`  | Submit terminal status; coordinator validates lease, job status, and report.                    |
| `GET /runner/update`                      | Read the runner's desired release and update command/state.                                     |
| `POST /runner/update-status`              | Report drain/install/restart/verification progress and installed digest.                        |

The current codebase has not yet implemented these coordinator routes or an API-only worker execution path. This document is a proposed contract, not a description of deployed behavior.

Claim requests contain runner protocol version and may include locally available capabilities; coordinator-side identity and team grants determine eligibility. A claim response includes a lease ID, opaque fencing token, server expiry, authoritative job/team identity, payload, and immutable workflow revision. Persist lease owner/expiry/generation in the coordinator database. Every renewal, secret/log/report/artifact write, and completion is conditional on the current fencing token. Stale workers cannot write after expiry/reclaim. Expect at-least-once execution; workflows with external side effects need idempotency of their own.

## Events and recovery

Use SSE event IDs, retry hints, and keepalives. Initial v1 event delivery is not a durable queue: after every connection or reconnect, the runner reconciles active leases and desired runner state through REST, then claims until capacity is full. `jobs.available` only wakes a claim loop; it does not include job data. Cancellation and update events are likewise hints to fetch authoritative state. REST polling with bounded backoff remains a fallback if SSE is unavailable.

## Management resources and self-update

- `GET /runners` and `GET /teams/{teamId}/runners` list registered runners, team grants, last heartbeat, active leases, runtime, current/desired version, and update state.
- `POST /teams/{teamId}/runners/{runnerId}` and `DELETE` on that resource grant/revoke an opted-in shared runner for that team; runner credentials do not change when a grant changes.
- `POST /runners/{runnerId}/updates` requests an update for one runner at a time with a pinned release version/digest. The coordinator persists an update state machine: `requested -> draining -> installing -> verifying -> succeeded`, or `failed/rolled-back`.
- The coordinator sends `runner.drain`/`runner.update` events and records progress reported by the runner. The runner's runtime adapter installs/restarts itself and reports the exact version/digest and health. UI never directly contacts a runner or runs systemd/Docker/Kubernetes commands.
- Update UI is available only when that runner reports a supported updater/runtime capability. Do not target a moving `latest` tag. Keep the previous release for rollback; enforce one active update at a time so stable runners continue serving jobs.

Enrollment, team grants, updates, and audit actions are separate operations. An update request affects only the selected runner, not every runner of a label or team.

## UI surfaces

- **Settings → Runners**: global runner inventory, enroll a shared runner, view health/capacity/version, and request/update one compatible runner with visible drain/install/verify/rollback progress.
- **Team settings → Runners**: team-scoped enrollment and runner status, plus an “Available shared runners” list with explicit activate/deactivate controls.
- Keep the team's webhook URL in Team settings and rotate it independently from runner credentials.

## Migration and release gates

1. Publish this API contract and schemas in OpenAPI; add conformance tests and a fake coordinator/client test harness.
2. Implement server-side enrollment, runner identity, leases, REST lifecycle operations, and authenticated SSE while retaining legacy worker routes.
3. Port the current Node runner to the protocol. `start-workers` must start without `DATABASE_URL`; the server remains the only DB owner. Keep legacy workers untouched.
4. Enroll one non-production runner in dev/lab. Verify job claim, reconnect/reconciliation, cancellation, logs/reports/artifacts, scoped secrets, token revocation, and no DB access.
5. Add durable update requests and a runtime-specific updater adapter; expose one-runner-at-a-time UI controls. Test failure and rollback on the canary while stable workers remain unchanged.
6. Only after the lab gates pass, plan a separate live canary. Do not migrate or update stable/live runners as part of the lab test.

## Initial acceptance criteria

- API-only runner starts and operates with no `DATABASE_URL`, database package, DB credentials, or DB network route.
- Two concurrent claims cannot own the same active lease; old lease credentials cannot renew or write after reassignment.
- Team grants are checked server-side for every claim and assignment operation; a runner cannot select another team/job by changing request fields.
- SSE loss/restart is harmless because REST reconciliation is authoritative.
- A lab-only self-update affects exactly one opted-in runner, verifies its pinned version, and rolls back or fails visibly without taking stable workers offline.
