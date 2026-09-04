# 🏃 `@cloud-cli/on`

General-purpose workflows

A self-hosted, lightweight, high-performance CI/CD runner engine built for Node.js.

Designed with a strict **security-first boundary**, native **JavaScript AST evaluation**, zero-DSL template literals, and a **built-in terminal log web dashboard**.

---

## 🌟 Key Highlights

- **Strict Code/Data Separation:** `run:` steps are executed verbatim as raw process scripts. Expressions and dynamic data bindings are isolated strictly to `env:`, eliminating shell-injection vectors entirely.
- **Standard ES Template Syntax (`${...}`):** No custom DSL wrappers like `${{ }}` or `{{ }}`. If a field contains `${...}`, it evaluates standard JavaScript template string logic via AST.
- **Deterministic Field Evaluation:** No silent fallbacks or ambiguous type conversions. Plain strings remain literal strings; conditions in `if:` fields run as strict JS boolean expressions.
- **Built-in Dark Mode Web UI (`/runs`):** Monitor job statuses live, inspect workspace inputs, and view ANSI-colored terminal log streams rendered in real-time.
- **System & Container Execution Drivers:** Run steps directly as detached host process groups or inside isolated Docker/Systemd transient units.
- **DB-authored workflows:** Draft, validate, and publish portable YAML workflows through the authenticated API.
- **Scheduled execution:** Published workflows can run from cron expressions or local sunrise/sunset events.
- **Encrypted secret storage:** Secret ciphertext is stored in the database; the master key remains on the HTTP server.

---

## 📦 Project Structure

```text
my-project/
├── runner.config.mjs        # (Optional) Engine configuration
└── package.json

```

---

## 🚀 Quick Start

### 1. Install & Run

Run the engine directly via `npx` or `pnpm dlx`:

```bash
# Start each role (normally managed by the supplied systemd units)
npx @cloud-cli/on start-server
npx @cloud-cli/on start-scheduler
npx @cloud-cli/on start-workers

```

### 2. Define a Workflow

```yaml
name: Build and Publish Release

on:
  github:
    events:
      - push
    owner: octocat
    repo:
      - example
      - another-example
    branches:
      - main
      - releases/*
    paths:
      - package*.json
    if: inputs.action !== 'deleted'

concurrency:
  group: release-${inputs.repo}
  cancel-in-progress: true

# Every tag must be advertised by the worker that claims this workflow.
tags: [linux, docker]

steps:
  - id: checkout
    name: Checkout Code Repository
    env:
      CLONE_URL: ${inputs.clone_url}
      COMMIT_SHA: ${inputs.commit_sha}
    run: |
      git clone --depth 1 "$CLONE_URL" .
      git checkout "$COMMIT_SHA"

  - id: install-and-build
    name: Install Dependencies & Build
    run: |
      pnpm install
      pnpm run build

  - id: publish
    name: Publish to NPM
    env:
      NPM_TOKEN: ${secrets.NPM_TOKEN}
    run: |
      echo "//registry.npmjs.org/:_authToken=$NPM_TOKEN" > ~/.npmrc
      npx --yes semantic-release@24 -b main --no-ci
```

Store the YAML as a draft and publish it through the authenticated API. Only published revisions can receive webhooks or scheduled runs:

```bash
curl -u admin:"$RUNNER_ADMIN_SECRET" -X POST http://localhost:11235/api/workflows/validate \
  -H 'Content-Type: application/json' --data '{"sourceYaml":"..."}'
curl -u admin:"$RUNNER_ADMIN_SECRET" -X PUT http://localhost:11235/api/workflows/build-and-publish-release \
  -H 'Content-Type: application/json' --data '{"sourceYaml":"..."}'
curl -u admin:"$RUNNER_ADMIN_SECRET" -X POST http://localhost:11235/api/workflows/build-and-publish-release/publish
```

Time triggers are defined beside a webhook trigger:

```yaml
on:
  schedule:
    - id: nightly
      cron: "0 2 * * *"
      timezone: Europe/Berlin
  solar:
    - id: morning
      event: sunrise
      latitude: 52.52
      longitude: 13.405
      offset: +15m
```

GitHub triggers support these preprocessor filters:

| Field | Match behavior |
| ----- | -------------- |
| `events` | Exact webhook event names |
| `owner`, `repo` | One exact name or a list of accepted names |
| `branches` | Branch glob patterns such as `main` or `releases/*` |
| `tag` | `true` requires a tag push; `false` requires a non-tag event |
| `tags` | Regular expressions matched against the pushed tag |
| `paths` | Changed-file glob patterns across added, modified, and removed files |

Configured fields are combined with AND. Values within one list are combined with OR. `tags` also requires a tag value to match, while `branches` requires a branch value to match. The generic `if` expression is evaluated separately after all preprocessor filters pass.

For example, a tag workflow can use `tag: true` with one or more regular expressions:

```yaml
on:
  github:
    events: [push]
    owner: octocat
    repo: example
    tag: true
    tags:
      - ^v1\..*
```

---

## 💻 CLI Usage & Commands

```bash
npx @cloud-cli/on [command] [options]

```

### Commands

| Command             | Description                                                                              |
| ------------------- | ---------------------------------------------------------------------------------------- |
| **`start-server`**  | Runs Webhook Ingress Gateway (the HTTP server receiving webhooks).                       |
| **`start-scheduler`** | Dispatches published cron and solar workflow triggers. |
| **`start-workers`** | Runs the event-driven worker scheduler (Scalable Workers).                              |

### CLI and Environment Options

| Flag | Option        | Default               | Env                   | Description                               |
| ---- | ------------- | --------------------- | --------------------- | ----------------------------------------- |
| `-h` | `--help`      | —                     | -                     | Prints CLI help message and exits.        |
| `-c` | `--config`    | `./runner.config.mjs` | `RUNNER_CONFIG_FILE`  | Path to JavaScript configuration file.    |
| `-d` | `--database`  | -                     | `RUNNER_DATABASE_URL` | SQLite database file path or HTTP URL.    |
| `-p` | `--port`      | `11235`               | `PORT`                | Port for the Ingress HTTP server.         |
| `-k` | `--workers`   | `5`                   | `RUNNER_WORKERS`      | Maximum concurrent jobs on this node.     |
|      |               |                       | `RUNNER_ADMIN_SECRET` | Admin token to refresh secrets via API    |
|      |               |                       | `RUNNER_SERVER_URL`   | Webhook server URL used by workers.       |
|      |               |                       | `RUNNER_TAGS`         | Comma-separated worker capability tags.  |

Set the same non-empty `RUNNER_ADMIN_SECRET` on the server and workers to publish live job-status refresh events and let workers retrieve job-scoped secrets. The dashboard workflow APIs accept either Bearer authentication or HTTP Basic authentication with username `admin` and this secret.

### Secrets

Secrets are written through `PUT /api/secrets/:NAME` and are AES-256-GCM encrypted in the database. Set `RUNNER_MASTER_KEY` only on the HTTP server, or provide an `on-master-key` systemd credential. Workers receive decrypted values only after claiming a running job; values are not written to job payloads or reports.

---

## ⚙️ Configuration Reference

You can customize engine behavior using `runner.config.mjs` in your project root:

```javascript
// runner.config.mjs
import { GitHubStatusPlugin } from '@cloud-cli/on';

export default {
  port: 3000,
  workers: 5,
  serverUrl: 'https://runner.example.com/',
  tags: ['linux', 'docker'],
  storagePath: '/tmp/workspaces',
  database: 'https://remote.db.com/',

  // Global environment variables passed to all steps
  env: {
    NODE_ENV: 'production',
  },

  plugins: [
    new GitHubStatusPlugin({
      token: process.env.SECRET_GITHUB_TOKEN,
      context: 'on',
    }),
  ],
};
```

The GitHub status plugin publishes commit states when a workflow starts and finishes. Its token needs permission to write commit statuses for the target repository.

Run details are available as HTML at `/runs/:id` and as sanitized JSON at `/api/runs/:id`. The HTML view refreshes reactively through job-specific SSE events while a run is active. Both representations omit raw webhook bodies, sensitive input fields, execution environment values, and internal rerun state.

---

## 📐 Deterministic Evaluation Rules

To prevent syntax ambiguity and injection risks, fields in workflow definitions operate under **three strict modes**:

```
┌──────────────────────────────────────────────────────────────────────────┐
│ 1. RAW PASSTHROUGH MODE (`run:`)                                         │
│ • Executed verbatim as a shell process command.                          │
│ • No string replacements or engine parsing performed.                    │
│ • Access environment variables strictly via shell syntax: $MY_VAR.       │
└──────────────────────────────────────────────────────────────────────────┘

┌──────────────────────────────────────────────────────────────────────────┐
│ 2. EXPRESSION MODE (`if:`, `eval:`)                                      │
│ • Evaluated strictly as pure JavaScript expressions via Acorn AST.       │
│ • Must be valid JS syntax (e.g. `inputs.branch === 'main'`).             │
│ • Automatically coerced to boolean in `if:` conditions.                  │
└──────────────────────────────────────────────────────────────────────────┘

┌──────────────────────────────────────────────────────────────────────────┐
│ 3. DETERMINISTIC VALUE MODE (`env:`, `name:`, `image:`, `group:`)        │
│ • Plain strings WITHOUT `${}` remain 100% raw literal strings.            │
│ • Strings WITH `${...}` evaluate as standard ES Template Literals.       │
│ • Example: `node:${inputs.node_version}-alpine`                          │
└──────────────────────────────────────────────────────────────────────────┘

```

### Context Scope Available in Expressions

Within `${...}`, `if:`, and `eval:` contexts, the following object scopes are exposed:

- **`inputs`**: Payload key-values received from incoming webhooks.
- **`env`**: Merged environment variables from global config and workflow definitions.
- **`secrets`**: Unmasked job-scoped values from encrypted central secret storage.
- **`steps`**: Execution statuses and outputs from previous steps in the workflow (`steps.<id>.status`, `steps.<id>.outputs`).
- **`BUILTIN_HELPERS`**: JS utilities including `String`, `Number`, `Boolean`, and `JSON.parse` / `JSON.stringify`.

---

## 🌐 Webhook Ingress Gateway & Dashboard

The Ingress Gateway listens for incoming HTTP requests and serves the live web UI.

### Endpoint Matrix

| Method     | Endpoint           | Description                                                                            |
| ---------- | ------------------ | -------------------------------------------------------------------------------------- |
| **`POST`** | `/webhooks/github` | Webhook endpoint for GitHub events. Applies GitHub filters and evaluates `on.github.if`. |
| **`GET`**  | `/runs`            | **Dashboard:** Live dark-mode monitoring page listing recent jobs and worker health.   |
| **`GET`**  | `/api/jobs?afterId=<id>&beforeId=<id>&limit=<n>` | Dashboard jobs with exclusive lower and upper ID cursors and a limit from 1 to 500 (default 50). |
| **`GET`**  | `/runs/:jobId`     | **Job Report:** Interactive HTML trace view with step timings and terminal log output. |

### Dashboard Features

- **Real-time Auto-Refresh:** `/runs` automatically refreshes job queue statuses (`PENDING`, `RUNNING`, `SUCCESS`, `FAILED`, `CANCELLED`).
- **ANSI Terminal Rendering:** Uses `ansi_up` to render bash colors, bold highlights, and console outputs accurately in step log boxes.
- **Payload Inspection:** View JSON inputs received from webhooks for easy debugging.

---

## 🔒 Security & Hardening

1. **Environment Variable Boundary:**
   By forcing shell steps to consume data via process environment variables (`$CLONE_URL`), malicious webhook payloads containing shell delimiters (e.g. `; rm -rf /`) cannot mutate shell script execution trees.
2. **Prototype Pollution Protection:**
   AST evaluation explicitly blocks access to dangerous JS properties (`constructor`, `__proto__`, `prototype`).
3. **Payload Size Guard:**
   The Ingress server enforces a strict 5MB payload limit to prevent Out-Of-Memory (OOM) denial-of-service attacks.
4. **Single-operator API authentication:**
   Workflow validation, publishing, secret management, and job details require `RUNNER_ADMIN_SECRET` over HTTPS.

## systemd Deployment

Install the unit files from `systemd/`, create a non-login `on` user, and create a root-owned `/etc/on/runner.env` with `RUNNER_DATABASE_URL`, `RUNNER_SERVER_URL`, `RUNNER_ADMIN_SECRET`, `RUNNER_TAGS`, and `RUNNER_TMP`. Use `systemctl edit` for per-machine overrides.

Place the server master key in `/etc/on/credentials/on-master-key` with permissions readable only by the `on` user. `runner-server.service` exposes it privately through systemd's credentials directory. Start the primary control plane with `systemctl enable --now runner.target`; enable `runner-worker.service` separately on worker machines. Use `systemctl edit runner-worker.service` for machine-specific labels and paths.

## Future Security Work

This MVP intentionally supports one trusted operator. Before sharing the UI or exposing it beyond a private deployment, add individual accounts and roles, secure browser sessions and CSRF protection, audit logs, worker enrollment credentials, secret key rotation, encrypted systemd credentials, rate limiting, and database high availability.

## Development

```bash
pnpm i
pnpm run lint
pnpm run test
pnpm run build
```
