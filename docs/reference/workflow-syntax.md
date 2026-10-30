# Workflow syntax reference

Workflows are YAML definitions saved in the control-plane database. Each save creates a revision; a queued job
keeps the revision it was created from. Filesystem `includes` are not supported.

## Minimal workflow

```yaml
id: hello
name: Hello

on:
  github:
    events: [push]
    owner: acme
    repo: web-app

steps:
  - id: greet
    env:
      REPOSITORY: ${inputs.full_name}
    run: printf 'Building %s\n' "$REPOSITORY"
```

`id` is required and normalized to lowercase hyphen-separated letters and numbers. `name` is the display name.
Use a signed workspace webhook for GitHub/Gitea events; see [Connect a GitHub or Gitea webhook](../how-to/connect-git-webhooks.md).

## Top-level fields

| Field             | Meaning                                                                          |
| ----------------- | -------------------------------------------------------------------------------- |
| `id`, `name`      | Stable workflow identity and display name.                                       |
| `on`              | Webhook, domain-event, cron, or solar trigger configuration.                     |
| `steps`           | Ordered, non-empty list of workflow steps; use instead of `using`.               |
| `using`           | Exact recipe reference such as `ada/container-build@v1`; use instead of `steps`. |
| `function`        | Optional exported recipe function to call.                                       |
| `with`, `secrets` | Ordinary and secret input bindings for a recipe workflow. Both must be objects.  |
| `env`             | Workflow environment values available to steps.                                  |
| `tags`            | Worker labels all required by the job.                                           |
| `matrix`          | Dimensions expanded into one job per Cartesian combination.                      |
| `concurrency`     | A concurrency `group` and optional `cancel-in-progress` policy.                  |
| `retries`         | Additional attempts after a failed step; applies per step, not to the whole job. |
| `cache`           | A cache `key` and workspace-relative `paths`.                                    |
| `artifacts`       | Workspace-relative `paths` to capture after successful execution.                |
| `secretFiles`     | Workspace-relative file paths mapped to secret names.                            |
| `plugins`         | Per-workflow plugin declarations and secret mappings.                            |

The accepted fields and constraints are defined by [`workflow.schema.json`](../../workflow.schema.json) and the
server's workflow validator.

## Triggers

The `on` mapping can contain one provider trigger plus optional `schedule`, `solar`, and `events` entries.

### GitHub and Gitea

Both connectors normalize verified push payloads. GitHub and Gitea workflow triggers accept filters including
`events`, `owner`, `repo`, `name`, `branches`/`refs`, `tag`, `paths`, and `if` where supported. Configured filters
are combined with AND; list values are alternatives. `branches` and `refs` accept glob patterns. `paths` matches
the changed files in the push payload.

```yaml
on:
  github:
    events: [push]
    owner: acme
    repo: web-app
    branches: [main, "release/*"]
    paths: ["src/**", package.json]
    if: inputs.action !== 'deleted'
```

The GitHub-only `github.fileExists(path)` helper can be used in a GitHub trigger condition to check a repository
path at the event's ref. A missing or inaccessible file does not trigger the workflow.

### Domain events

Use `on.events` to subscribe to one or more workspace-scoped event types:

```yaml
on:
  events: [git.push]
```

An event subscription starts at its registration boundary; it does not implicitly replay prior events. See
[Webhooks, domain events, and workspace data](../explanation/domain-events.md).

### Provider-independent webhook intake

Use `on.webhook` when a workflow should react to named webhook event headers without binding its trigger to the
provider slug in the webhook URL. Signature verification still happens at ingress. The workflow can transform the
original request and use `dispatch` to pass a normalized contract to a provider-agnostic workflow:

```yaml
id: github-push-intake
name: GitHub push intake
on:
  webhook:
    events: [push]
steps:
  - id: normalize
    eval: |
      ({
        repository: JSON.parse(body.toString('utf8')).repository.full_name,
        clone_url: JSON.parse(body.toString('utf8')).repository.clone_url,
        commit_sha: JSON.parse(body.toString('utf8')).after,
        ref: JSON.parse(body.toString('utf8')).ref
      })
  - id: build
    dispatch: docker-build
    with: "({ repository: steps.normalize.outputs.repository, clone_url: steps.normalize.outputs.clone_url, commit_sha: steps.normalize.outputs.commit_sha, ref: steps.normalize.outputs.ref })"
```

`on.webhook.events` is required and matches the event name (for GitHub, `x-github-event`). `dispatch` queues a
published workflow in the same workspace through the existing authenticated, idempotent workflow invocation path.
The target workflow should validate its input contract and check out the immutable commit, not a mutable branch head.

### Scheduled triggers

Cron expressions use five fields and may specify an IANA timezone:

```yaml
on:
  schedule:
    - id: nightly
      cron: "0 2 * * *"
      timezone: Europe/Berlin
```

Solar triggers use `sunrise` or `sunset`, coordinates, and an optional timezone and offset:

```yaml
on:
  solar:
    - id: morning
      event: sunrise
      latitude: 52.52
      longitude: 13.405
      timezone: Europe/Berlin
      offset: +15m
```

## Steps

Every step has one execution form: `run`, `eval`, or `dispatch`.

| Field                   | Meaning                                                                                     |
| ----------------------- | ------------------------------------------------------------------------------------------- |
| `id`                    | Stable step identity used in reports and `steps.<id>` expressions.                          |
| `name`                  | Display label; defaults to the step ID.                                                     |
| `if`                    | Safe JavaScript expression; false skips this and all later steps in the current execution.  |
| `env`                   | Environment values for this step, evaluated in declaration order.                           |
| `run`                   | Raw shell script executed by the selected worker driver. Not expression-interpolated.       |
| `eval`                  | Safe JavaScript expression evaluated by the worker; its result is available as step output. |
| `dispatch`              | ID or unique name of a published workflow in the same workspace.                            |
| `with`                  | Structured input object or expression for a `dispatch` step.                                |
| `image`                 | Optional Docker image for a `run` step. Requires worker-side Docker support.                |
| `volumes`, `dockerArgs` | Additional Docker volume mappings or arguments. These are privileged options.               |
| `timeoutMs`             | Step timeout in milliseconds. Default: `30000`.                                             |

Use environment bindings to keep data separate from shell source:

```yaml
steps:
  - id: deploy
    env:
      TARGET: ${inputs.environment}
      TOKEN: ${secrets.DEPLOY_TOKEN}
    run: ./deploy.sh --target "$TARGET"
```

### Check out the exact commit

For a push workflow, fetch the webhook's commit SHA and detach at that revision rather than building the branch's
possibly newer head:

```yaml
steps:
  - id: checkout
    env:
      clone_url: ${inputs.clone_url}
      commit_sha: ${inputs.commit_sha}
    run: |
      git clone --depth 1 "$clone_url" .
      git fetch --depth 1 origin "$commit_sha"
      git checkout --detach "$commit_sha"
```

## Expressions and values

Strings without `${...}` are literal. Supported value fields such as workflow/step `env`, cache keys, concurrency
groups, and recipe input bindings evaluate `${...}` as a JavaScript-style expression. `if` and `eval` accept
expressions directly. The evaluator is a restricted AST interpreter, not a full JavaScript runtime.

Available data roots include `inputs`, `headers`, `body`, `env`, `secrets`, `steps`, and (in supported contexts)
`files` and `github`. For webhooks, `headers` contains the sanitized request headers and `body` is the original
request body as a Node.js `Buffer`, preserving binary payloads. Ingress parses `inputs` as JSON only when the request
content type is `application/json` or a `+json` media type; for other content types, workflows can inspect
`body` directly.
`files.exists`, `files.readFile`, and `files.join` are limited to the job workspace. Built-ins include `String`,
`Number`, `Boolean`, and `JSON.parse`/`JSON.stringify`.

Do not put `${inputs.*}` expressions inside `run:`. Shell scripts are passed through unchanged; bind values via
`env` and read them with quoted shell variables. Step `name`, `image`, `volumes`, and `dockerArgs` are literal
values in the current worker.

## Recipe workflows

Pin an immutable published recipe version. Use `with` for ordinary inputs and `secrets` for write-only secret
inputs:

```yaml
using: ada/container-build@v1
with:
  image: ghcr.io/acme/web-app:latest
secrets: {}
```

Named function exports can be selected with `function: build`. See the [recipe syntax reference](recipe-syntax.md).

## Matrix, retries, and outputs

```yaml
matrix:
  node: [20, 22]
tags: [linux]
retries: 1
```

Each matrix combination becomes a separate job and receives `MATRIX_*` environment variables. `retries` controls
additional attempts for each failed step. Earlier step state and outputs are available under
`steps.<step-id>.status` and `steps.<step-id>.outputs`.
