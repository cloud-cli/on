# Workflow Documentation

This is the living documentation for workflow authors. It is organized using the four Diataxis modes:

- **Tutorials** teach the shortest path to a working workflow.
- **How-to guides** solve focused tasks.
- **Reference** documents the accepted syntax.
- **Explanation** describes execution and security decisions.

## Tutorials

### Your First Workflow

Create a draft in the authenticated workflow editor, or send the YAML to the API:

```yaml
id: hello
name: Hello

on:
  generic: {}

steps:
  - id: greet
    name: Greet
    run: echo "Hello ${inputs.name}"
```

Save it, validate it, and publish it. Only published and enabled workflows receive webhook or scheduled events.

To test without changing the schedule or publishing first, save the draft and select **Run now** in the workflow editor. The editor queues the latest saved draft revision immediately; a worker must still be running.

The `generic` provider accepts a JSON request body as `inputs`. For example:

```bash
curl -X POST http://localhost:11235/api/v1/webhooks/generic \
  -H 'content-type: application/json' \
  --data '{"name":"Ada"}'
```

### Build a GitHub Workflow

```yaml
id: build
name: Build

on:
  github:
    events: [push]
    owner: cloud-cli
    repo: on
    branches: [main]

steps:
  - id: checkout
    name: Checkout
    env:
      clone_url: ${inputs.clone_url}
      commit_sha: ${inputs.commit_sha}
    run: |
      git clone --depth 1 "$clone_url" .
      git checkout "$commit_sha"

  - id: test
    name: Test
    run: pnpm install && pnpm test
```

GitHub webhooks must be signed with the configured `GITHUB_WEBHOOK_SECRET`. The preprocessor exposes normalized inputs including `event`, `owner`, `repo`, `branch`, `tag`, `ref`, `full_name`, `clone_url`, `commit_sha`, `author`, `action`, `changes`, and the original `raw` body.

GitHub workflow `if:` conditions also receive an async `github.fileExists(path)` helper. It checks the repository contents API using the webhook's owner, repository, and ref:

```yaml
on:
  github:
    if: github.fileExists('Dockerfile')
```

The helper is only available to GitHub workflows. A missing file returns `false`; unsafe paths and failed lookups do not trigger the workflow.

#### Provider aliases and workflow-owned normalization

Workspace webhook registrations can use any provider slug, including a provider alias configured for a GitHub sender. For a non-built-in slug the server does not normalize the provider payload: it verifies `X-Hub-Signature-256` against the registration signing secret (or the workspace secret named `<SLUG>_WEBHOOK_SECRET`) using the original request bytes, parses JSON, and supplies `inputs.body` and `inputs.request.headers` to the workflow. Only an allowlist of event metadata headers is forwarded; credentials and arbitrary custom headers are omitted. `inputs.raw` is also the parsed JSON value; it is **not** the original byte sequence. A valid signing secret and signature are required; unsigned alias ingress is rejected. Configure a registration signing secret rather than relying on an unscoped environment variable.

Alias workflows do not inherit `on.github`'s server-side filters or `github.fileExists` helper. Normalize and filter in workflow steps using `inputs.body` and `inputs.request.headers`; use `on: { alias: {} }`. The `on.github` provider path remains the legacy compatibility path: it continues to produce normalized GitHub inputs and apply existing `events`, repository/branch/path filters and `github.fileExists` conditions.

The migration fixture at `tests/test.yaml` uses the isolated `github-test` alias. Its trigger expression accepts only pushes to `cloud-cli/on-github-workflow-migration-test` on `main`, then an `eval` step reports normalized repository, owner, repo, ref/branch, SHA, and commit message. It posts pending/final commit statuses from ordinary workflow steps using the workspace-managed `GITHUB_TOKEN`; no token value belongs in YAML. The fixture deliberately avoids the production `github` provider, so it can validate raw payload handling and workflow-owned status reporting without changing legacy webhook behavior. `tests/runner.config.mjs` does not register a GitHub status plugin.

```yaml
id: github-intake
name: GitHub intake (alias)
on:
  scm-hook: {}
steps:
  - id: normalize
    eval: "({ event: inputs.request.headers['x-github-event'], repository: inputs.body.repository?.full_name, ref: inputs.body.ref, raw: inputs.body })"
```

### Dispatch structured output to another workflow

An API runner may use a dispatch-only step to pass structured step outputs as downstream workflow inputs. `dispatch` accepts a stable workflow ID or an exact, unique workflow name; `with` is an expression evaluated in the source workflow context. The downstream target must be published in the same workspace.

```yaml
steps:
  - id: normalize
    eval: "({ repository: inputs.body.repository.full_name, event: inputs.request.headers['x-github-event'] })"
  - id: handoff
    dispatch: build-and-test # workflow ID; a unique workflow name is also accepted
    with: steps.normalize.outputs
```

The handoff is server-authenticated with the active runner lease; workflows do not need embedded API keys or shell `curl` calls. The downstream `inputs` is the structured object (not a JSON-encoded string), and the downstream run's parent is the source job. Dispatch is idempotent per source job and step, including runner/step retries. Inputs are limited to 256 KiB and dispatch ancestry to five downstream levels. A dispatch-only step requires the lease-based API runner; a local non-API worker fails it explicitly rather than bypassing server authorization.

## How-To Guides

### Reference Another Environment Value

Environment entries are evaluated from top to bottom. Earlier values are available through `env` to later values:

```yaml
env:
  image: ${inputs.repo}
  image_tag: ${env.image}:latest
  artifact_name: ${env.image_tag}-${inputs.commit_sha}
```

Workflow-level values are available to every step. Step-level `env` values are evaluated after workflow-level values and can override them for that step.

Use `${inputs.name}`, `${env.NAME}`, `${secrets.NAME}`, and `${steps.step_id.outputs.value}` where the value is available. A value without `${...}` remains literal text.

### Run a Container with a Host Volume

Use `image` with `volumes`. A volume is passed directly to `docker run` as a `-v` mapping:

```yaml
steps:
  - id: sign
    name: Sign release
    image: alpine:latest
    volumes:
      - /var/lib/runner/secrets-store:/secrets:ro
    run: |
      ./sign.sh /secrets/signing.key dist/release.tar.gz
```

The source path is on the worker host. The destination path is inside the container. Use absolute host paths when a specific host directory is required. The workflow must be trusted because volume mappings can expose host data to a container.

A single string is also accepted:

```yaml
volumes: /var/lib/runner/secrets-store:/secrets:ro
```

### Pass Additional Docker Arguments

Use `dockerArgs` for additional arguments to `docker run`, before the image name:

```yaml
steps:
  - id: build
    image: docker:cli
    dockerArgs:
      - --network=host
      - --user=1000:1000
    run: docker build -t example:latest .
```

Arguments are not interpreted or shell-expanded by the runner. They are passed as individual Docker CLI arguments.

### Use a Matrix

Keep the matrix in the workflow definition:

```yaml
id: package
name: Package

matrix:
  node: [18, 20]
  os: [ubuntu, alpine]

tags:
  - "${matrix.os}"

on:
  generic: {}

env:
  node_version: ${env.MATRIX_NODE}

steps:
  - id: package
    image: node:${env.MATRIX_NODE}
    run: npm pack
```

The runner creates one job for every Cartesian combination. The example creates four jobs. Each variant receives `MATRIX_NODE` and `MATRIX_OS` environment variables. Matrix expressions in `tags` are resolved before enqueueing, so each job can target a different runner. Tags remain an AND requirement within each job.

If a matching runner is offline before claiming its matrix job, the job remains pending and is claimed when that runner reconnects. A job already claimed by a worker is recovered as stale after one hour if the worker process does not complete it.

### Add a Scheduled Trigger

```yaml
on:
  schedule:
    - id: nightly
      cron: "0 2 * * *"
      timezone: Europe/Berlin
```

Cron expressions have five fields: minute, hour, day of month, month, and day of week. The scheduler uses the declared IANA timezone.

Solar triggers use `sunrise` or `sunset` and geographic coordinates:

```yaml
on:
  solar:
    - id: morning
      event: sunrise
      latitude: 52.52
      longitude: 13.405
      offset: +15m
```

### Use Secrets

Create a secret in the management UI or with the API, then reference it in environment values:

```yaml
steps:
  - id: publish
    env:
      npm_token: ${secrets.NPM_TOKEN}
    run: npm publish
```

Secret values are delivered to a worker after it claims the job. Do not write them into reports or artifacts.

Managed secrets can be text or binary. Use the management UI's file picker for binary values, or send base64 through the API:

```json
{
  "value": "<base64 file bytes>",
  "encoding": "base64",
  "originalName": "release.keystore"
}
```

Binary values are encrypted at rest and are decoded only when written through a file secret mapping. They should not be injected into environment variables.

### Persist Artifacts and Caches

Artifacts are captured from the workspace after a successful run:

```yaml
artifacts:
  paths:
    - dist
    - reports/**/*.json
```

Caches are restored before steps start and saved after a successful run:

```yaml
cache:
  key: npm-${inputs.repo}-${inputs.branch}
  paths:
    - node_modules
```

Configure a shared FileBin backend on the server and workers with `RUNNER_FILE_API_URL`, `RUNNER_FILE_BIN`, and optionally `RUNNER_FILE_PASSWORD`. Create a bin with `POST /bin`, then configure its ID. Without FileBin configuration, the runner uses the central database fallback. Cache keys are scoped by workflow; artifacts are scoped by job. Stored collections are limited to 50 MiB per capture.

Administrators can download a captured artifact with `GET /api/v1/runs/:jobId/artifacts/:path`.

Populate workspace files from managed secrets before steps run:

```yaml
secretFiles:
  .config/signing.key: SIGNING_KEY
```

Secret files are created with owner-only permissions in the worker workspace. They must be handled according to the worker storage lifecycle and should not be included in artifacts or caches.

### Configure Workflow Plugins

Enable status updates for an individual GitHub workflow by declaring a plugin and mapping its secret inputs through the existing server-managed secrets:

```yaml
plugins:
  - name: github-status
    secrets:
      GITHUB_TOKEN: ${secrets.GITHUB_TOKEN}
    context: ci/build
```

The worker uses that secret for `pending`, `success`, `failure`, or `error` commit statuses. The token is never stored in workflow YAML or job reports. The workflow must have GitHub `owner`, `repo`, and `commit_sha` inputs; otherwise no status request is made.

Plugin names are resolved through the server's workflow plugin registry. `github-status` is built in. External integrations can register a factory during runner configuration with `registerWorkflowPlugin(name, factory)` before workers start.

## Reference

### Top-Level Workflow Fields

| Field         | Type     | Description                                                                                                                     |
| ------------- | -------- | ------------------------------------------------------------------------------------------------------------------------------- |
| `name`        | string   | Required human-readable workflow name shown in the UI and reports.                                                              |
| `id`          | string   | Optional identifier used when deriving an ID outside the management API. The management API ID is authoritative after creation. |
| `on`          | object   | Required trigger configuration.                                                                                                 |
| `env`         | object   | Workflow environment values, evaluated in declaration order.                                                                    |
| `matrix`      | object   | Matrix dimensions. Each value is an array of strings, numbers, or booleans.                                                     |
| `concurrency` | object   | Optional concurrency group and cancellation policy.                                                                             |
| `tags`        | string[] | Worker capability tags required by the job.                                                                                     |
| `artifacts`   | object   | Workspace paths captured after successful runs.                                                                                 |
| `cache`       | object   | Keyed workspace paths restored before and saved after successful runs.                                                          |
| `secretFiles` | object   | Workspace-relative file paths mapped to secret names.                                                                           |
| `plugins`     | object[] | Optional per-workflow plugin declarations and secret mappings.                                                                  |
| `steps`       | object[] | Required non-empty ordered list of steps.                                                                                       |
| `retries`     | integer  | Additional attempts for a failed step. Must be zero or greater.                                                                 |

`includes` and workflow-to-workflow imports are not supported. Workflow definitions are stored as complete database revisions. Reusable behavior should be implemented through the planned step reuse mechanism rather than filesystem imports.

### Triggers

The first non-`schedule`/`solar` key in `on` is the provider trigger. Supported providers include `generic` and `github`.

#### GitHub Trigger Filters

| Field      | Type               | Behavior                                                    |
| ---------- | ------------------ | ----------------------------------------------------------- |
| `events`   | string[]           | Exact event names such as `push` or `pull_request`.         |
| `owner`    | string or string[] | Exact repository owner.                                     |
| `repo`     | string or string[] | Exact repository name.                                      |
| `name`     | string or string[] | Exact `owner/repo` name.                                    |
| `branches` | string or string[] | Glob patterns matching normalized branches or tags.         |
| `refs`     | string or string[] | Alias for branch/ref matching.                              |
| `tag`      | boolean            | Requires a tag push when true, a non-tag event when false.  |
| `tags`     | string[]           | Regular expressions matched against the tag value.          |
| `paths`    | string[]           | Glob patterns matched against changed files.                |
| `if`       | string or string[] | Safe JavaScript condition evaluated after provider filters. |

Configured fields are combined with AND. Multiple values within a field are combined with OR. Negated `!value` entries are supported by exact-value filters.

#### Schedule Trigger

```yaml
schedule:
  - id: hourly
    cron: "0 * * * *"
    timezone: UTC
```

#### Solar Trigger

```yaml
solar:
  - id: sunrise-build
    event: sunrise
    latitude: 52.52
    longitude: 13.405
    timezone: Europe/Berlin
    offset: -15m
```

### Environment and Expressions

Interpolated strings use standard JavaScript template expressions inside `${...}`. The safe evaluator supports literals, property access, arithmetic, comparisons, boolean operators, ternaries, arrays, objects, and these helpers:

```text
String(value)
Number(value)
Boolean(value)
JSON.parse(value)
JSON.stringify(value)
```

Available context objects are:

| Object    | Available data                                                               |
| --------- | ---------------------------------------------------------------------------- |
| `inputs`  | Trigger payload and normalized provider inputs.                              |
| `env`     | Runner environment plus earlier workflow or step environment entries.        |
| `secrets` | Decrypted job-scoped secrets.                                                |
| `steps`   | Earlier step statuses, exit codes, and outputs.                              |
| `files`   | Workspace-scoped `exists`, `readFile`, and `join` helpers for `eval:` steps. |

Expressions cannot access JavaScript constructors or prototypes. Shell commands are not expression-evaluated; only declared interpolation fields are evaluated.

### Steps

| Field        | Type               | Description                                                |
| ------------ | ------------------ | ---------------------------------------------------------- |
| `id`         | string             | Stable identifier used by `steps.<id>`.                    |
| `name`       | string             | Display name. Defaults to `id`.                            |
| `run`        | string             | Shell command or script. Mutually exclusive with `eval`.   |
| `eval`       | string             | In-process safe expression. Mutually exclusive with `run`. |
| `env`        | object             | Step environment, evaluated after workflow environment.    |
| `image`      | string             | Docker image. Selects container execution for the step.    |
| `volumes`    | string or string[] | Docker `-v` mappings.                                      |
| `dockerArgs` | string[]           | Additional raw arguments for `docker run`.                 |
| `timeoutMs`  | positive integer   | Maximum step runtime. Defaults to 30 seconds.              |
| `if`         | string             | Safe condition. False conditions produce a skipped step.   |

`run` steps execute through the selected worker driver. With `image`, the command runs as `sh -c` inside Docker. Without `image`, it runs through the worker shell. `eval` steps run inside the worker process and can produce structured outputs for later steps.

### Management and API

Workflow definitions are drafted, validated, published, enabled, and deleted through the authenticated management UI or these endpoints:

```text
POST /api/v1/workflows/validate
GET  /api/v1/workflows
GET  /api/v1/workflows/:id
PUT  /api/v1/workflows/:id
POST /api/v1/workflows/:id/publish
POST /api/v1/workflows/:id/run
DELETE /api/v1/workflows/:id
```

Only published workflows with `enabled: true` are matched for incoming triggers. Saving a workflow creates a new immutable revision. Existing jobs continue to use the revision recorded when they were created.

`POST /api/v1/workflows/:id/run` requires `workflows:write` and queues the latest saved revision directly. Send `{}` as the JSON body, or provide manual inputs as `{ "inputs": { "name": "value" } }`. Direct runs may execute draft revisions and do not require the scheduler.

## Explanation

### Why Workflow YAML Lives in the Database

The server stores source YAML and normalized revisions in the database. Workers are stateless: they fetch the referenced revision when claiming a job and do not read workflow files from their local filesystem. This keeps every worker on the same definition and makes published revisions reproducible.

### Why Matrix Expansion Happens at Trigger Time

The stored revision remains one canonical workflow. When a trigger matches, the server creates one queue job per matrix combination. The payload records the matrix context, and the worker resolves that same variant before execution. This avoids storing duplicate workflow revisions while keeping each job independently observable.

### Docker Volumes and Trust

`volumes` and `dockerArgs` are intentionally powerful options. A host volume can expose credentials or signing material, and Docker arguments can change networking, users, capabilities, or isolation. Only trusted administrators should publish workflows using these fields. The runner does not copy, inspect, or redact files mounted into containers.

### Reuse and Imports

Filesystem imports were removed because workers no longer load workflow files. Future step reuse should operate on database-owned definitions or explicit reusable step mechanisms, keeping revisioning and authorization visible to the control plane.

# Workflow identity

Every workflow definition must include an explicit `id`, separate from its human-readable `name`. IDs are canonicalized to lowercase hyphen-separated ASCII letters and numbers, and must be unique within a workspace. This YAML ID is the stable reference for dispatch; the database management key is separate. Changing the name does not change identity, while changing `id` creates a new definition identity and can require downstream dispatch references to be updated.

On databases that already contain workflows, migration 009 backfills each stored revision with its existing normalized ID (or management key when none exists) and updates the editable source YAML. Standalone backups are not changed automatically: add a stable `id` before importing or restoring them. Reuse the prior management ID when possible. Missing IDs fail validation, and duplicate IDs within one workspace are rejected.
