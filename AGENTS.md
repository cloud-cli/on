# 🚀 Systemd-Native Distributed CI/CD Runner Engine

A lightweight, stateless, distributed CI/CD runner engine built with **Node.js**, **SQLite**, and **systemd transient units (`systemd-run`)**.

Designed with a decoupled **Control Plane (Server)** and **Stateless Workers** architecture, it allows centralized workflow management, label-based task dispatching, and secure process isolation on Linux hosts.

---

## 🏛️ System Architecture

```text
               ┌─────────────────────────────────────────────────────────┐
               │                    MAIN SERVER NODE                     │
               │                                                         │
               │  ┌───────────────────────────────────────────────────┐  │
               │  │             runner-server.service                 │  │
               │  │  - Listens for Webhooks / API triggers             │  │
               │  │  - Syncs local /workflows/*.yaml -> Database      │  │
               │  └────────────────────────┬──────────────────────────┘  │
               │                           │                             │
               │                           ▼                             │
               │  ┌───────────────────────────────────────────────────┐  │
               │  │                     SQLite DB                     │  │
               │  │  - workflow_definitions                           │  │
               │  │  - jobs                                           │  │
               │  │  - job_attempts                                   │  │
               │  └────────────────────────┬──────────────────────────┘  │
               └───────────────────────────┼─────────────────────────────┘
                                           │
          ┌────────────────────────────────┴────────────────────────────────┐
          │ (Polling via HTTP / Direct DB Queue)                            │
          ▼                                                                 ▼
┌──────────────────────────────────┐               ┌──────────────────────────────────┐
│        LOCAL WORKER NODE         │               │        REMOTE WORKER NODE        │
│    (on primary server node)      │               │       (secondary machine)        │
│                                  │               │                                  │
│      runner-worker.service       │               │      runner-worker.service       │
│  - RUNNER_LABELS="main,docker"   │               │  - RUNNER_LABELS="build-agent"   │
│  - Zero local workflow files     │               │  - Zero local workflow files     │
└──────────────────────────────────┘               └──────────────────────────────────┘

```

---

## 🔑 Core Design Principles

### 1. Fully Stateless Workers

Workers store **no local workflow files**. Workflow definitions live centrally in SQLite on the server. When claiming a job attempt, the worker dynamically joins the latest step commands from the `workflow_definitions` table. Updating a workflow YAML on the server immediately affects all workers across the cluster.

### 2. Native Systemd Isolation (`systemd-run`)

Steps execute as transient systemd services. This ensures clean process sandboxing, resource tracking (CPU/Memory peaks), automatic cleanup on exit, and native process termination on cancels/timeouts.

### 3. Label-Based Dispatching (`runs-on`)

Jobs specify execution constraints (e.g., `runs-on: ["main-server", "docker"]`). The queue dispatcher evaluates worker capabilities against job constraints using SQLite set-intersection logic (`json_each`), ensuring jobs run only on nodes equipped to handle them.

### 4. Multi-Attempt History (`jobs` vs. `job_attempts`)

To support job re-runs while preserving failure history, job tracking is split into parent metadata (`jobs`) and individual execution runs (`job_attempts`).

---

## 🛠️ Systemd Driver & Engine Execution Rules

Through our debugging, several critical Linux & systemd integration mechanics were established for process execution:

### 1. Systemd Transient Unit Hygiene

When invoking `systemd-run`:

- **Unique Unit Names:** Unit names must be dynamic per attempt (`job-${jobId}-${stepId}-${Date.now()}`) to bypass systemd's in-memory transient unit cache.
- **Garbage Collection (`--collect`):** Always pass `--collect` so systemd unloads the unit definition immediately upon exit.
- **Service Type (`--property=Type=exec`):** Prevents systemd from misinterpreting short-lived CLI tools (`git`, `npm`) as failing background daemons.

### 2. Environment & `PATH` Propagation

Systemd transient units run in a stripped environment by default. Node must explicitly pass its active `PATH` and job variables using `--setenv`:

```typescript
const envFlags = [`--setenv=PATH=${process.env.PATH || '/usr/local/bin:/usr/bin:/bin'}`];
```

### 3. Exit Code vs. `stderr` Parsing

- **Do NOT treat `stderr` content as process failure.** Command-line tools (such as `git clone`, `git checkout`, `npm`, and `systemd-run` itself) write standard diagnostic logs and memory summaries to `stderr`.
- Step success or failure **must be derived strictly from `exitCode !== 0**`.

### 4. Workspace Permissions (`/wd`)

To prevent `status=200/CHDIR` or `Permission Denied` errors when non-root users/git operate inside root-created workspace folders, explicitly set permissions when creating step workspaces:

```typescript
fs.mkdirSync(targetWd, { recursive: true });
fs.chmodSync(targetWd, 0o777); // Allows traversability and write access
```

---

## 🗄️ Database Schema Summary

```sql
-- 1. Centralized Workflow Definitions (Synced from disk on server boot)
CREATE TABLE IF NOT EXISTS workflow_definitions (
  id TEXT PRIMARY KEY,          -- e.g. "deploy-app"
  name TEXT NOT NULL,
  runs_on TEXT,                 -- JSON array e.g. '["main-server"]'
  steps TEXT NOT NULL,           -- JSON array of step definitions
  updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

-- 2. Parent Jobs (1 per trigger/webhook event)
CREATE TABLE IF NOT EXISTS jobs (
  id TEXT PRIMARY KEY,                  -- e.g. "job-101"
  workflow_id TEXT NOT NULL,             -- FK to workflow_definitions.id
  commit_sha TEXT,
  branch TEXT,
  triggered_by TEXT,                     -- e.g. "webhook" or "user:alex"
  latest_status TEXT DEFAULT 'pending',  -- 'pending', 'running', 'success', 'failed'
  current_attempt INTEGER DEFAULT 1,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

-- 3. Job Execution Attempts (1 per run / re-run)
CREATE TABLE IF NOT EXISTS job_attempts (
  id TEXT PRIMARY KEY,                  -- e.g. "job-101-1"
  job_id TEXT NOT NULL,                 -- FK to jobs.id
  attempt INTEGER NOT NULL,             -- 1, 2, 3...
  status TEXT DEFAULT 'pending',        -- 'pending', 'running', 'success', 'failed'
  worker_id TEXT,
  reports TEXT,                         -- JSON array of step outcomes & execution times
  log_path TEXT,                        -- Path to attempt log on disk
  started_at TIMESTAMP,
  completed_at TIMESTAMP,
  FOREIGN KEY (job_id) REFERENCES jobs(id) ON DELETE CASCADE
);

```

---

## 🚦 Systemd Service Configuration

The platform is split into two distinct, independently manageable systemd services.

### 1. Server Unit (`/etc/systemd/system/runner-server.service`)

_(Deployed on the Primary Node)_

```ini
[Unit]
Description=CI/CD Runner Control Plane Server
After=network.target

[Service]
Type=simple
User=root
WorkingDirectory=/opt/runner
ExecStart=/usr/bin/pnpm start:server
Restart=always
RestartSec=5
Environment=PORT=3000

[Install]
WantedBy=multi-user.target

```

### 2. Worker Unit (`/etc/systemd/system/runner-worker.service`)

_(Deployed on Main Server and All Worker Nodes)_

```ini
[Unit]
Description=CI/CD Stateless Execution Worker
After=network.target runner-server.service

[Service]
Type=simple
User=root
WorkingDirectory=/opt/runner
ExecStart=/usr/bin/pnpm start:worker
Restart=always
RestartSec=5
Environment=RUNNER_LABELS="main-server,docker"
Environment=RUNNER_TMP=/var/lib/runner/workspaces

[Install]
WantedBy=multi-user.target

```

---

## 🎯 Next Roadmap Milestones

- [ ] Implement `POST /api/jobs/:id/rerun` to append new attempt rows to `job_attempts`.
- [ ] Build UI Tab View for comparing logs across attempts (`Attempt 1` vs `Attempt 2`).
- [ ] Implement log streaming (WebSocket/SSE) from worker processes to central DB/storage.

---

## V3 delivery and agent coordination

The authoritative product proposal is `v3.md` on the `v3` branch. Before implementing a v3 change, compare that proposal with the current branch and read `docs/v3-implementation-plan.md`. Treat examples in `v3.md` as design notation, not as settled schemas or APIs. Preserve existing behavior and migrations unless the approved slice explicitly changes them.

### Parallel agent workflow

- For every substantial v3 task, keep the lead model responsible for scope, architecture, security, integration, and acceptance. Break work into independent, bounded tasks and start multiple suitable subagents in parallel when their work does not conflict. Prefer GPT-6 Luna specialists; use the documented fallback if one is unavailable or cannot complete the task.
- Give each agent explicit paths, constraints, acceptance criteria, and required checks. Assign a single owner per overlapping file set. Use read-only agents for analysis/review and implementation agents only for isolated changes.
- Track each agent's task, status, relevant findings, and changed paths in the active task checklist. Check returned status/handoffs; do not treat a claimed completion as proof. Independently inspect every diff and run the checks required for integration.
- At the end of **every turn that advances v3**, calculate progress using the milestone weights and evidence rules in `docs/v3-implementation-plan.md`. Report the percentage and remaining blockers. If progress is below 100%, identify next tasks and launch agents for the next unblocked, bounded work; do not repeat unchanged work or overlap active work. Continue across turns until all milestones are accepted or explicitly report why work is blocked/deferred.
- Recalculate progress from the repository and tests, not from effort, estimates, agent claims, or documentation alone. A design document or plan is not implementation progress.

### End-to-end and production authentication checks

- Use local/unit/integration E2E against isolated fixtures for routine verification. The current `pnpm test:e2e` is a Docker smoke test, not proof of a real browser login or the v3 product journeys.
- Only run production OIDC browser tests when the requested flow exists and the test can use the documented temporary-client procedure in the global OIDC runbook. Read the current Auth API and discovery specifications first; use `AGENT_ID`/`AGENT_SECRET` only in the documented Agent sign-in flow. Create a uniquely named temporary client with exact redirect URIs and always delete it in `finally`; cleanup failure is a blocker. Never expose credentials, client secrets, cookies, tokens, or sensitive page content.
- Run Playwright against the exact v3 flows implemented, covering authorization and relevant failure paths. Capture screenshots at relevant viewport sizes as test artifacts, inspect console/network errors, and ensure screenshots contain no secrets or private user data. Do not claim a production test or screenshot exists unless it was actually run and reviewed. Do not use production data or mutate production workflows/resources for testing.

### Current v3 implementation status (2026-10-26)

This is a working-tree status snapshot, not a completion claim. Recalculate it from source and fresh checks at the end of each v3 turn. The fixed weights and acceptance criteria in `docs/v3-implementation-plan.md` remain authoritative.

- **Overall estimate: 62%.** Evidence-based partial milestone credits: M1 contracts/compatibility/migrations **7/10**; M2 durable events/common admission **16/20**; M3 callable recipes/workflow contracts **11/15**; M4 channels/history/live experience **14/15**; M5 attempts/checkpoints/replay/follow-ups **9/20**; M6 connectors/agents/E2E **5/20**. M2 has file-backed SQLite recovery/outcome coverage and a durable plan-ready transaction gate preventing partial matrix dispatch; recovery pagination now uses monotonic event sequence. Its common admission path remains unaccepted: API workflow requests use durable workflow-run admission while external subscriptions call the queue dispatcher directly. M3 tests invalid nested input/output schemas, unsupported expressions, secret-map failures, and parent retry identity/reporting; nested-call timeout fields are now rejected rather than silently ignored. M4 evidence includes durable sequence/index tests, reconnect reconciliation across pages, scoped message/run/causation links, and the production asset route for the channels module. M4 still lacks a persisted live-stream proof, invocation model/link, and status parity with run details. M5 now rejects stale runner attempt writes and fails closed before executing when a durable start fact cannot be inserted; this is not restart-safe identity or replay. Partial credit does not mean a milestone is accepted.
- **Implemented evidence:** v3 contracts and additive migrations; durable typed event/delivery and workflow-run admission repositories with fencing/recovery; grants for agent workflow access; exact-pinned nested recipe function calls with revocation checks, validation, explicitly mapped secrets, and nested reports/attempt records; durable channel event history with pagination/retry/reload UI and indexed sequence cursors; immutable attempt-start markers and a derived `interrupted_or_unknown` read state. Nested calls execute inline in the parent job; they are not independent child jobs. Missing completion does not distinguish a still-running worker from an interrupted worker.
- **Latest observed checks:** `pnpm test` — **92 files, 532 tests passed**; `pnpm lint`; `pnpm build`; `git diff --check`; `pnpm exec playwright test --config=playwright.config.mjs tests/playwright/channels.spec.mjs` — **6 passed**; `pnpm test:worker-artifact`; and `pnpm test:e2e` Docker smoke passed. Docker smoke now also fetches the production server's app-router, channels, and API-client JavaScript assets; it is not browser login or v3 journey acceptance. A review found step-log redaction was not applied to the durable log write; this was corrected and the checks above were rerun.
- **Visual/auth evidence:** channel desktop/mobile/narrow screenshots are in `test-results/channels/` and were reviewed in the prior work session. The unusable shell startup had a concrete missing dependency: `/assets/channels-ui.mjs` was imported by the router but not served; the server now serves it and Docker smoke checks the endpoint. A real authenticated shell browser journey has not yet been run. Production OIDC Agent sign-in browser verification did **not** run; there are no production-auth screenshots. Existing temporary OIDC and database resources were cleaned up. The retained app log shows server startup, but the health-probe failure’s HTTP status/transport error was not retained, so the cause is unknown. Before retrying OIDC setup, add/recover redacted probe diagnostics and distinguish direct app health from proxy health; do not proceed to browser tests until setup works and the documented temporary-client cleanup path is in place.
- **Remaining acceptance blockers:** Milestone 1 needs complete compatibility/rollback evidence and review of all contract decisions. Milestone 2 needs a common admission path across API and external event requests and complete accepted/rejected/filtered/duplicate/unmatched/failed outcome semantics; event-delivery duplicate/unmatched are currently evidenced as fanout behavior, not explicit statuses. Milestone 3 still needs broader legacy compatibility and independently inspectable call-tree acceptance. Milestone 4 still needs proof against a real persisted live event stream, invocation links, an authenticated shell journey, and status parity with run detail. Milestone 5 lacks restart-safe attempt identity, checkpoint storage/retention, isolated replay/resume, and side-effect-safe recovery tests. A fail-closed duplicate-start guard prevents silently repeating an attempt under the old ordinal, but does not make it resumable. Milestone 6 lacks the complete normalized connector/agent journey coverage and successful v3 browser acceptance.
- **Repository/delivery state:** the reviewed partial v3 implementation is committed and pushed to `main` as `5e12ff0`; this status checkpoint is in the following documentation commit. The documented On API was queried for workflows and jobs after push; no active workflow for this repository was found (the active workflows/jobs were for other projects), so no CI result is claimed. No deployment URL/details were available, and no deployment smoke test was attempted.
- **Next actions:** (1) define and implement shared admission semantics for API and external event requests; (2) implement the immutable attempt identity protocol, then checkpoints and safe replay; (3) diagnose the OIDC app health probe using redacted evidence and run documented browser flow only if setup is safe; (4) complete invocation/run causal references and persisted live-stream verification; (5) re-review the complete diff, rerun checks, and recalculate weighted progress.
