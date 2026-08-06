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
- **Automatic Secret Redaction:** Secrets loaded from `.env` are automatically masked (`***`) across all terminal log outputs and report snapshots.

---

## 📦 Project Structure

```text
my-project/
├── .on/                     # Workflow definitions directory
│   ├── release.yml
│   └── test.yml
├── .env                     # Local secrets (git-ignored)
├── runner.config.mjs        # (Optional) Engine configuration
└── package.json

```

---

## 🚀 Quick Start

### 1. Install & Run

Run the engine directly via `npx` or `pnpm dlx`:

```bash
# Start full engine (Ingress HTTP Gateway + 5 Worker Loops)
npx @cloud-cli/on start

```

### 2. Configure Secrets (`.env`)

Secrets are automatically loaded from `.env` at the root of your project. Prefix secrets with `SECRET_`:

```env
SECRET_NPM_TOKEN="npm_1234567890abcdef"
SECRET_GITHUB_TOKEN="ghp_1234567890abcdef"
SECRET_GITHUB_WEBHOOK_SECRET="my-webhook-secret"

```

### 3. Define a Workflow (`.on/release.yml`)

```yaml
name: Build and Publish Release

on:
  github:
    if: inputs.event === 'push' && inputs.branch === 'main'

concurrency:
  group: release-${inputs.repo}
  cancel-in-progress: true

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

---

## 💻 CLI Usage & Commands

```bash
npx @cloud-cli/on [command] [options]

```

### Commands

| Command                 | Description                                                               |
| ----------------------- | ------------------------------------------------------------------------- |
| **`start`** _(default)_ | Runs both Webhook Ingress Gateway and Worker execution loops together.    |
| **`start-server`**      | Runs Webhook Ingress Gateway only (API / Gateway mode).                   |
| **`start-workers`**     | Runs Worker Polling loops only (Scalable Worker mode).                    |
| **`validate`**          | Parses and validates all YAML workflows in `.on/` without executing jobs. |

### CLI Options

| Flag | Option        | Default                    | Description                               |
| ---- | ------------- | -------------------------- | ----------------------------------------- |
| `-c` | `--config`    | `./runner.config.mjs`      | Path to JavaScript configuration file.    |
| `-d` | `--database`  | `process.env.DATABASE_URL` | SQLite database file path or HTTP URL.    |
| `-w` | `--workflows` | `.on/`                     | Directory where workflow YAML files live. |
| `-p` | `--port`      | `3000`                     | Port for the Ingress HTTP server.         |
| `-k` | `--workers`   | `5`                        | Number of worker loop threads to spawn.   |
| `-h` | `--help`      | —                          | Prints CLI help message and exits.        |

---

## ⚙️ Configuration Reference

You can customize engine behavior using `runner.config.mjs` in your project root:

```javascript
// runner.config.mjs
import { HtmlReporter, SlackReporter, JsonFileReporter } from '@cloud-cli/on/reporters';

export default {
  port: 3000,
  workersCount: 5,
  workflowsDir: '.on/',
  storagePath: '/tmp/workspaces',
  sqliteUrl: 'sqlite.db',

  // Global environment variables passed to all steps
  env: {
    NODE_ENV: 'production',
  },

  // Custom execution reporters
  reporters: [
    new JsonFileReporter({ outputDir: './reports/json' }),
    new HtmlReporter({ outputDir: './reports/html' }),
    new SlackReporter({
      webhookUrl: process.env.SLACK_WEBHOOK_URL,
      channel: '#ci-deployments',
    }),
  ],
};
```

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
- **`secrets`**: Unmasked secret values loaded from `.env` (`SECRET_` prefix stripped).
- **`steps`**: Execution statuses and outputs from previous steps in the workflow (`steps.<id>.status`, `steps.<id>.outputs`).
- **`BUILTIN_HELPERS`**: JS utilities including `String`, `Number`, `Boolean`, and `JSON.parse` / `JSON.stringify`.

---

## 🌐 Webhook Ingress Gateway & Dashboard

The Ingress Gateway listens for incoming HTTP requests and serves the live web UI.

### Endpoint Matrix

| Method     | Endpoint           | Description                                                                            |
| ---------- | ------------------ | -------------------------------------------------------------------------------------- |
| **`POST`** | `/webhooks/github` | Webhook endpoint for GitHub events. Evaluates `on.github.if` triggers.                 |
| **`GET`**  | `/runs`            | **Dashboard:** Live dark-mode monitoring page listing recent jobs and worker health.   |
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
4. **Signal Traps & Resource Cleanup:**
   Graceful process traps (`SIGINT`, `SIGTERM`) ensure active job handles are safely terminated, file descriptors are closed, and temp `.env`/`.out` files are removed via `try ... finally` blocks.

## Development

```bash
pnpm i
pnpm run lint
pnpm run test
pnpm run build
```
