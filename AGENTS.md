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
const envFlags = [`--setenv=PATH=${process.env.PATH || "/usr/local/bin:/usr/bin:/bin"}`];
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

The authoritative product proposal is `v3.md` on the `v3` branch. Before implementing a v3 change, compare that proposal with the current branch and read `docs/project/v3-implementation-plan.md`. Treat examples in `v3.md` as design notation, not as settled schemas or APIs. Preserve existing behavior and migrations unless the approved slice explicitly changes them.

### Parallel agent workflow

- For every substantial v3 task, keep the lead model responsible for scope, architecture, security, integration, and acceptance. Break work into independent, bounded tasks and start multiple suitable subagents in parallel when their work does not conflict. Prefer GPT-6 Luna specialists; use the documented fallback if one is unavailable or cannot complete the task.
- Give each agent explicit paths, constraints, acceptance criteria, and required checks. Assign a single owner per overlapping file set. Use read-only agents for analysis/review and implementation agents only for isolated changes.
- Track each agent's task, status, relevant findings, and changed paths in the active task checklist. Check returned status/handoffs; do not treat a claimed completion as proof. Independently inspect every diff and run the checks required for integration.
- At the end of **every turn that advances v3**, calculate progress using the milestone weights and evidence rules in `docs/project/v3-implementation-plan.md`. Report the percentage and remaining blockers. If progress is below 100%, identify next tasks and launch agents for the next unblocked, bounded work; do not repeat unchanged work or overlap active work. Continue across turns until all milestones are accepted or explicitly report why work is blocked/deferred.
- Recalculate progress from the repository and tests, not from effort, estimates, agent claims, or documentation alone. A design document or plan is not implementation progress.

### End-to-end and production authentication checks

- Use local/unit/integration E2E against isolated fixtures for routine verification. The current `pnpm test:e2e` is a Docker smoke test, not proof of a real browser login or the v3 product journeys.
- Only run production OIDC browser tests when the requested flow exists and the test can use the documented temporary-client procedure in the global OIDC runbook. Read the current Auth API and discovery specifications first; use `AGENT_ID`/`AGENT_SECRET` only in the documented Agent sign-in flow. Create a uniquely named temporary client with exact redirect URIs and always delete it in `finally`; cleanup failure is a blocker. Never expose credentials, client secrets, cookies, tokens, or sensitive page content.
- Run Playwright against the exact v3 flows implemented, covering authorization and relevant failure paths. Capture screenshots at relevant viewport sizes as test artifacts, inspect console/network errors, and ensure screenshots contain no secrets or private user data. Do not claim a production test or screenshot exists unless it was actually run and reviewed. Do not use production data or mutate production workflows/resources for testing.

### Current v3 implementation status (2026-10-27)

This is a working-tree status snapshot, not a completion claim. Recalculate it from source and fresh checks at the end of each v3 turn. The fixed weights and acceptance criteria in `docs/project/v3-implementation-plan.md` remain authoritative.

- **Overall estimate: 73.55%** (report as 74%; evidence fractions sum to 73.55%). Milestone credits: M1 contracts/compatibility/migrations **7.2/10**; M2 durable events/common admission **19.5/20**; M3 callable recipe functions/workflow contracts **13.25/15**; M4 Streams/history/live experience **14.85/15**; M5 attempts/checkpoints/replay/follow-ups **10/20**; M6 connectors/agents/E2E **8.75/20**. This remains a partial-evidence estimate; no milestone is fully accepted. New M1 evidence adds migration-033 same-workspace backfill/idempotency characterization and interrupted-marker retry coverage for additive migrations 031–035. Migration tests do not establish a production backup/restore procedure or older-binary compatibility. M2 persists `matched`, `repeat`, and `unmatched` fanout outcomes and uses durable per-variant admission plans for API and internal-dispatch requests; full cross-path accepted/rejected/filtered/duplicate/unmatched/failed parity remains open. M3 has exact-pinned nested recipe calls, bounded redacted contexts, child-step links, legacy-row compatibility evidence, and run-detail UI coverage; broader compatibility remains incomplete. M4 now uses canonical Stream/Thread APIs in the UI, including workspace navigation, Stream/Thread list/create/read/write, cursor-paginated Thread messages, and existing Stream event-history cursor behavior. Local Playwright covers reconnect/history, Thread pagination, and desktop/mobile presentation; integrated authenticated Streams/history acceptance remains incomplete. M6 has exact-commit checkout and Agent invocation/result correlation evidence, but the latter uses a terminal-job fixture rather than a real executing worker; centralized mirror selection and complete agent journeys remain open.
- **Implemented evidence:** additive migrations; durable typed events, delivery fanout outcomes and workflow-run admission with fencing/recovery; explicit workspace-scoped Stream/event bindings; agent workflow grants; exact-pinned nested recipe calls with additive call-instance reports; separate Threads; immutable step-attempt identities and bounded redacted snapshots. GitHub and Gitea now normalize verified push payloads to the same `git.push` data shape, with provider-specific provenance and delivery idempotency. Stream live notifications are wake-ups only; durable event history/cursors remain authoritative. Nested calls remain inline in the parent job; attempt evidence is not checkpoint/replay support.
- **Latest observed checks:** `pnpm lint`; `pnpm test` — **110 files, 613 tests passed**; `pnpm build`; `git diff --check`; and local Playwright without production-auth test — **15/15 passed**, including Stream history, reconnect, Thread pagination, and desktop/mobile paths. Authenticated OIDC browser test timed out on the most recent attempt; this is not passing evidence for integrated Streams/history. Earlier OIDC Agent login and workspace-shell journey passed against an isolated SQLite fixture using synthetic data, including quick-switch keyboard navigation, logout, and unauthorized access; its temporary client cleanup path completed. The UI/layout changes include explicit narrow grid track constraints, rounded profile container, and deferred focus for Cmd/Ctrl+K input.
- **Visual/auth evidence:** prior synthetic Stream, invocation, run-detail, and quick-switch screenshots were reviewed. The 320px shell overflow was corrected and a narrow screenshot showed the shell within viewport; the latest authenticated browser retry timed out, so do not count it as complete acceptance. No production data was used. No outstanding local OIDC SQLite fixture directory remained during cleanup.
- **Remaining acceptance blockers:** M1 needs full compatibility/rollback evidence, contract review, and demonstrated operational backup/restore. M2 needs common admission parity and complete cross-path accepted/rejected/filtered/duplicate/unmatched/failed semantics. M3 needs broader legacy compatibility and full nested parent/child call-tree acceptance. M4 needs authenticated Streams/history journeys in the integrated workspace experience. M5 lacks durable checkpoint storage/retention, isolated replay/resume, and side-effect-safe recovery. M6 lacks verified mirror selection, complete agent subscription/tool/result journeys, and integrated provider-neutral browser acceptance.
- **Repository/delivery state:** commits through `fce2a08` are pushed to `main`; the worktree is clean. No matching CI workflow or deployment details were available, so CI/deployment checks are unavailable and no deployment smoke test was attempted. Generated failed OIDC error-context files were removed; successful screenshots and ordinary local Playwright artifacts remain as test evidence.
- **Next actions:** diagnose/stabilize the authenticated OIDC journey, then add integrated authenticated Streams/history acceptance; complete common admission outcome parity and broader nested-call compatibility; define checkpoint storage/retention and side-effect contracts before replay; review the contract/rollback evidence and operational backup/restore; continue verified mirror selection and full Agent journeys, then recalculate milestone evidence.
