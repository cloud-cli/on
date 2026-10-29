# Create and test a workflow

This tutorial creates a workflow that accepts GitHub push events and runs a small shell step. It assumes the
control plane and a runner are available. For webhook delivery, follow [Connect a GitHub or Gitea webhook](../how-to/connect-git-webhooks.md).

## 1. Create a draft

Sign in, select a workspace, and open **Workflows → New workflow**. Paste this YAML into the editor:

```yaml
id: build
name: Build

on:
  github:
    events: [push]
    owner: acme
    repo: web-app
    branches: [main]

tags: [linux]

steps:
  - id: summarize
    name: Summarize push
    env:
      EVENT: ${inputs.event}
      REPOSITORY: ${inputs.full_name}
      COMMIT_SHA: ${inputs.commit_sha}
    run: |
      printf 'Event: %s\n' "$EVENT"
      printf 'Repository: %s\n' "$REPOSITORY"
      printf 'Commit: %s\n' "$COMMIT_SHA"
```

Change `acme/web-app` and the branch to match your repository. The `linux` tag must match an authorized runner. In
`env`, workflow expressions pass values from the webhook payload to the step. The `run` script itself is passed to
the shell unchanged and reads those values as ordinary shell variables.

## 2. Validate and run the draft

Use **Validate** in the editor, correct any reported errors, and save the draft. Select **Run now** to queue the
saved draft immediately; a matching runner must be online. A manual run has no GitHub push payload, so the summary
values may be empty, but the step should still complete.

Open the run from the dashboard to inspect status, step output, and logs.

## 3. Publish it for automatic events

When the manual run succeeds, publish and enable the workflow. Only published, enabled revisions receive webhook
and scheduled events. Add the configured workspace webhook URL and signing secret to GitHub, then push to the
configured branch. The dashboard and incoming-event view show whether the delivery was accepted and which jobs it
queued.

## Next steps

- Add filters such as `paths`, `tag`, or a workflow `if` condition; see the [workflow syntax reference](../reference/workflow-syntax.md).
- Store credentials as [workspace secrets](../how-to/manage-secrets.md), not in YAML or shell source.
- Reuse a published immutable recipe with [the recipe tutorial](create-recipe.md).
