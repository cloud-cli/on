# Architecture and execution model

On separates workflow management from job execution. The **control plane** owns database access, workflow
revisions, authorization, connector ingress, scheduling, and durable run state. **API-only runners** enroll with a
workspace or shared scope, then claim authorized work over HTTPS.

```text
Connectors / user / schedule
              │
              ▼
       Ingress + API ─────── OIDC sign-in / workspace UI
              │
              ├──────────── Database module
              │               workflows, events, jobs, history
              │
              ├──────────── Scheduler
              │               cron and solar triggers
              │
              └── HTTPS leases, reports, logs, scoped secrets
                       │
              ┌────────┴────────┐
              ▼                 ▼
         API runner 1       API runner N
         process/systemd/Docker execution adapters
```

## Processes and state

- `start-server` serves the web app and HTTP API, accepts connector events, captures ingress receipts, and coordinates workflow/job state.
- `start-scheduler` dispatches published cron and solar triggers.
- `start-workers` runs an API-only Node worker. It does not need the database module or its credentials.
- `start-workers-legacy` is a database-connected compatibility path, not the recommended new deployment.

Workflow YAML is authored through the authenticated UI/API and stored as database revisions, rather than read from
runner-local workflow files. Jobs retain the workflow revision they were created from. Recipes are globally
published immutable versions. Workspaces scope workflow data, secrets, connector registrations, and runner grants.

The control-plane `DATABASE_URL` is an importable JavaScript module URL exposing the database adapter interface;
it is not a SQL DSN. The supplied server startup runs pending migrations. API workers use an issued credential and
an HTTPS coordinator URL instead.

## Event and execution lifecycle

Connector ingress receipts, normalized domain events, delivery attempts, workflow invocations, and runs are separate
records. An accepted connector event can be recorded without matching a workflow. A domain event can be durably recorded
before any worker starts. A run becomes complete only when execution reports a terminal status.

The scheduler and event dispatcher admit work into the same job system. Runners heartbeat, claim work matching
their workspace grant and labels, fetch the pinned workflow and only that job's secrets, then submit logs,
reports, attempt records, and completion through lease-authenticated APIs. SSE messages wake the runner; REST
state remains authoritative after reconnects.

## Execution drivers

The Node worker selects systemd transient-service execution where supported and otherwise uses a standard process
driver. A step with `image` uses Docker execution and requires a Docker CLI/daemon available to the runner. Driver
availability and host privileges are properties of the runner, not the control plane.

The standalone Go module in `runner/` is currently an early configuration/transport foundation, not a complete
workflow executor. The supported workflow execution path is the Node API worker.
