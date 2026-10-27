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

### Current v3 implementation status (2026-10-27)

This is a working-tree status snapshot, not a completion claim. Recalculate it from source and fresh checks at the end of each v3 turn. The fixed weights and acceptance criteria in `docs/v3-implementation-plan.md` remain authoritative.

- **Overall estimate: 72.75%** (report as 73%; evidence fractions sum to 72.75%). Milestone credits: M1 contracts/compatibility/migrations **7/10**; M2 durable events/common admission **19.25/20**; M3 callable recipes/workflow contracts **13/15**; M4 Streams/history/live experience **14.75/15**; M5 attempts/checkpoints/replay/follow-ups **10/20**; M6 connectors/agents/E2E **8.75/20**. M2 persists `matched`, `repeat`, and `unmatched` fanout outcomes, direct API input rejection, and internal runner-dispatch requests as durable per-variant admission plans with pinned revisions, fencing, stable parent/step retry identity, and recovery from the immutable persisted variant plan. Isolated-SQLite tests verify rejected admission remains stable across API retries and internal-dispatch retries; a successful domain-event subscription test now verifies that admitted delivery correlates to a durable accepted per-variant plan after SQLite reopen. A successful internal dispatch now exercises the actual lease handler, durable variant claimant, worker-admission processor and queue-admission stub, and verifies same-step retry preserves the pinned plan and job identity after reopen. Webhook characterization tests preserve distinct legacy receipt and normalized-event outcomes across matched, unmatched, rejected, and failed cases. Complete accepted/rejected/filtered/duplicate/unmatched/failed parity still needs cross-path acceptance. M3 records distinct recipe-call instances with pinned targets, attempt status, child-step links, bounded redacted context, permission-checked run-view projections, worker evidence for nested parent/child call-tree identities, and real run-detail browser coverage for child-step selection and independent permission gating. New compatibility tests prove persisted legacy recipe rows remain callable via `main`, pin their exact nested body/contracts, and fail closed for missing exact versions; broader compatibility remains incomplete. M4 has SQLite reopen/resume evidence, a Playwright wake-up-to-cursor-reconciliation test, explicit invocation IDs distinct from addressed request-event IDs, run status fetched from the canonical run-detail API with workspace-scoped notification refresh, and OIDC Agent browser evidence for workspace-shell authorization and quick-switch behavior; integrated authenticated Streams/history acceptance remains incomplete. M6 has network-free exact-commit checkout coverage, a new local-Git regression proving a lagging selected clone source fails closed rather than using its branch head, and local Agent request → durable admission → workspace-scoped invocation/result-correlation coverage with redaction and grant checks; the latter uses a persisted terminal-job fixture, not a real executing worker. Centralized mirror selection, full agent tool/result journeys, and integrated provider-neutral browser acceptance remain incomplete. Partial credit does not mean a milestone is accepted.
- **Implemented evidence:** additive migrations; durable typed events, delivery fanout outcomes and workflow-run admission with fencing/recovery; explicit workspace-scoped Stream/event bindings; agent workflow grants; exact-pinned nested recipe calls with additive call-instance reports; separate Threads; immutable step-attempt identities and bounded redacted snapshots. GitHub and Gitea now normalize verified push payloads to the same `git.push` data shape, with provider-specific provenance and delivery idempotency. Stream live notifications are wake-ups only; durable event history/cursors remain authoritative. Nested calls remain inline in the parent job; attempt evidence is not checkpoint/replay support.
- **Latest observed checks:** this turn's `pnpm test` — **108 files, 593 tests passed**; `pnpm lint`; `pnpm build`; `git diff --check`; successful subscription admission persistence; accepted internal dispatch/retry/reopen; local-Git exact-commit and lagging-source fail-closed checkout; Agent invocation/result correlation; legacy nested-recipe pinning; and quick-switch template assertions. The documented temporary-client OIDC Agent browser journey passed against an isolated local SQLite fixture, including authorization, quick-switch filter/empty/keyboard navigation, logout, and unauthorized access. Desktop/mobile screenshots use synthetic data and were captured and reviewed. The Agent UI receives a 403 from the workers endpoint; the test records that as an expected permission response. `pnpm test:worker-artifact` passed in the preceding implementation slice. Earlier real run-page local-fixture Playwright coverage passed **3 tests** at desktop/mobile sizes. The preceding nested-call slice also passed Docker smoke and 9 channel Playwright tests, but those checks were not rerun for subsequent admission changes. Integrated authenticated Streams/history acceptance remains incomplete.
- **Visual/auth evidence:** existing channel desktop/mobile/narrow screenshots and invocation desktop/mobile screenshots were reviewed. Synthetic run-detail and quick-switch desktop/mobile screenshots were captured and visually reviewed; tests cover call-to-step selection, separate input/log visibility, quick-switch filtering and keyboard navigation. Production OIDC Agent sign-in ran through the documented temporary-client procedure; cleanup succeeded in the passing test's `finally` path. The test uses synthetic data and an isolated SQLite fixture, not production workflows or jobs.
- **Remaining acceptance blockers:** M1 needs full compatibility/rollback evidence and contract review. M2 needs common admission parity and complete cross-path accepted/rejected/filtered/duplicate/unmatched/failed semantics. M3 needs broader legacy compatibility and full nested parent/child call-tree acceptance. M4 needs authenticated Streams/history journeys in the integrated workspace experience. M5 lacks durable checkpoint storage/retention, isolated replay/resume, and side-effect-safe recovery. M6 lacks verified mirror selection, complete agent subscription/tool/result journeys, and integrated provider-neutral browser acceptance.
- **Repository/delivery state:** recent pushed slices include the central URLPattern route table and bound router views, webhook outcome characterization, cross-path durable rejection and acceptance coverage, documented exact-commit checkout with local-Git tests, Agent invocation/job correlation, successful subscription-to-admission persistence, accepted internal dispatch/retry/reopen coverage, and the authenticated quick-switch test. Agent and subscription terminal job IDs are fixtures, not worker execution. The current working tree adds the lagging-source fail-closed checkout regression. No workflow matching this repository was found, so no CI result is available. No deployment URL/details were available and no deployment smoke test was attempted.
- **Next actions:** complete cross-path admission outcome/recovery acceptance; broaden nested-call UI coverage and compatibility; define checkpoint storage/retention and side-effect contracts before replay; add authenticated Streams/history journeys; define/verify any centralized mirror-selection contract and broaden agent journeys; complete compatibility/rollback review; then recalculate milestone evidence.
