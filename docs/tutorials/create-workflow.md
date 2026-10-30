# Create and test a workflow

This tutorial creates an event-driven workflow that runs a small shell step. It assumes the control plane and a
runner are available. To receive HTTP requests and publish domain events, configure a [connector](../how-to/connectors.md).

## 1. Create a draft

Sign in, select a workspace, and open **Workflows → New workflow**. Paste this YAML into the editor:

```yaml
id: build
name: Build

on:
  events: [sample.received]

tags: [linux]

steps:
  - id: summarize
    name: Summarize event
    env:
      EVENT_TYPE: ${inputs.type}
      SOURCE: ${inputs.source}
    run: |
      printf 'Event type: %s\n' "$EVENT_TYPE"
      printf 'Source: %s\n' "$SOURCE"
```

The `linux` tag must match an authorized runner. Domain-event data is available under `inputs`; adjust the fields to
match the event contract. In `env`, workflow expressions pass values to the step. The `run` script itself is passed
to the shell unchanged and reads those values as ordinary shell variables.

## 2. Validate and run the draft

Use **Validate** in the editor, correct any reported errors, and save the draft. Select **Run now** to queue the
saved draft immediately; a matching runner must be online. A manual run does not include domain-event data, so the
summary values may be empty, but the step should still complete.

Open the run from the dashboard to inspect status, step output, and logs.

## 3. Publish it for automatic events

When the manual run succeeds, publish and enable the workflow. Only published, enabled revisions receive domain
events and scheduled events. Configure an ingress connector following the [connector guide](../how-to/connectors.md).
Incoming-event receipts record ingress processing; replaying a receipt re-evaluates the stored request through the
connector's current revision and publishes a new event. Use **Run now** or the workflow run API to rerun a workflow;
receipt replay is not a workflow rerun.

## Next steps

- Add a workflow `if` condition; see the [workflow syntax reference](../reference/workflow-syntax.md).
- Store credentials as [workspace secrets](../how-to/manage-secrets.md), not in YAML or shell source.
- Reuse a published immutable recipe with [the recipe tutorial](create-recipe.md).
