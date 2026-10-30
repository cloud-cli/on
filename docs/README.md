# Documentation

Start with the [getting started tutorial](tutorials/getting-started.md) to deploy the ingress/control plane and
connect a runner. The rest of the user documentation follows the four Diátaxis modes:

## Tutorials

Learn by completing a working task.

- [Getting started: deploy On and connect a runner](tutorials/getting-started.md)
- [Create and test a workflow](tutorials/create-workflow.md)
- [Publish and use a recipe](tutorials/create-recipe.md)

## How-to guides

Solve a specific operational or authoring problem.

- [Configure OIDC sign-in](how-to/configure-oidc.md)
- [Create and manage an HTTP connector](how-to/connectors.md)
- [Manage workspace secrets](how-to/manage-secrets.md)
- [Run an API worker in a container](how-to/install-api-runner.md)

## Reference

Look up exact syntax, configuration, and API contracts.

- [Workflow syntax](reference/workflow-syntax.md)
- [Recipe syntax](reference/recipe-syntax.md)
- [Configuration and CLI](reference/configuration.md)
- [HTTP API and OpenAPI](reference/http-api.md)
- [Workflow JSON Schema](../workflow.schema.json)
- [Recipe JSON Schema](../recipe.schema.json)

## Explanation

Understand the design and the reasons behind it.

- [Architecture and execution model](explanation/architecture.md)
- [Security boundaries](explanation/security.md)
- [Webhooks, domain events, and workspace data](explanation/domain-events.md)

## Project notes

Design proposals, implementation tracking, and rollout records live in [Project notes](project/README.md). They are
not product contracts; check the running source and the references above for current behavior.
