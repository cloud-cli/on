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
