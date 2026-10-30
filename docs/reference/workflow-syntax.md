# Workflow syntax reference

Workflows are YAML definitions saved in the control-plane database. Each save creates a revision; a queued job
keeps the revision it was created from. Filesystem `includes` are not supported.

## Minimal workflow

```yaml
id: hello
name: Hello

on:
  events: [sample.received]

steps:
  - id: greet
    env:
      EVENT_TYPE: ${inputs.type}
    run: printf 'Received event %s\n' "$EVENT_TYPE"
```

`id` is required and normalized to lowercase hyphen-separated letters and numbers. `name` is the display name.
Use workspace domain events to start event-driven workflows. Configure HTTP ingress with a connector; see
[Create and manage an HTTP connector](../how-to/connectors.md).

## Top-level fields

| Field             | Meaning                                                                          |
| ----------------- | -------------------------------------------------------------------------------- |
| `id`, `name`      | Stable workflow identity and display name.                                       |
| `on`              | Domain-event, cron, or solar trigger configuration.                              |
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

The `on` mapping can contain `events`, `schedule`, and `solar` entries.

### Domain events

Use `on.events` to subscribe to one or more workspace-scoped event types:

```yaml
on:
  events: [deployment.completed]
```

An event subscription starts at its registration boundary; it does not implicitly replay prior events. Connectors
accept ingress and publish normalized domain events. See [Create and manage an HTTP connector](../how-to/connectors.md)
and [Webhooks, domain events, and workspace data](../explanation/domain-events.md).

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

## Expressions and values

Strings without `${...}` are literal. Supported value fields such as workflow/step `env`, cache keys, concurrency
groups, and recipe input bindings evaluate `${...}` as a JavaScript-style expression. `if` and `eval` accept
expressions directly. The evaluator is a restricted AST interpreter, not a full JavaScript runtime.

Available data roots include `inputs`, `env`, `secrets`, `steps`, and (in supported contexts) `files`. Workflows receive
their JSON `inputs` interface; raw HTTP request bodies and headers are not workflow bindings. Connectors own HTTP
payload parsing, signature checks, and data mapping. See the [connector guide](../how-to/connectors.md) for its separate
bounded input context and normalized event contract.
`files.exists`, `files.readFile`, and `files.join` are limited to the job workspace. Built-ins include `String`,
`Number`, `Boolean`, and `JSON.parse`/`JSON.stringify`.

Do not put `${inputs.*}` expressions inside `run:`. Shell scripts are passed through unchanged; bind values via
`env` and read them with quoted shell variables. Step `name`, `image`, `volumes`, and `dockerArgs` are literal
values in the current worker.

## Recipe workflows

Pin an immutable published recipe version. Use `with` for declared ordinary inputs and `secrets` for declared recipe
secrets. Defaults are applied to omitted ordinary inputs; required unmapped inputs or secrets are rejected:

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
