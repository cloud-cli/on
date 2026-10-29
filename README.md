# On

**On is a self-hosted workflow platform for teams that want control over where automation runs.**
Define workflows in YAML, manage them in a web app, and execute jobs on runners you operate.

## Why On

- **Run close to your systems.** Dispatch jobs by runner labels across one machine or a distributed fleet.
- **Keep control and execution separate.** The ingress/control plane owns workflow state; API-only workers connect over HTTPS and do not need database credentials.
- **Build on reusable automation.** Use immutable, versioned recipes, GitHub and Gitea webhooks, schedules, matrices, and workflow dispatch.
- **Keep access scoped.** Workspaces isolate workflows, runs, and encrypted secrets; sign in with OIDC and grant runner access explicitly.
- **See what happened.** Follow runs, step logs, outputs, attempts, artifacts, and event history in the web UI.

## Get started

The [getting started guide](docs/tutorials/getting-started.md) walks through an HTTPS ingress instance,
the scheduler, and your first workspace-scoped runner. Then follow the tutorials to
[create a workflow](docs/tutorials/create-workflow.md) and [publish a recipe](docs/tutorials/create-recipe.md).

Browse the [documentation index](docs/README.md), the [HTTP API contract](docs/reference/http-api.md), or the
[workflow syntax reference](docs/reference/workflow-syntax.md).

## Development

```sh
pnpm install
pnpm lint
pnpm test
pnpm build
```

The Go runner in `runner/` is an early transport/configuration foundation, not a workflow-compatible production
runner. Use the Node API worker for workloads; see [project notes](docs/project/README.md) for design material.

MIT licensed.
