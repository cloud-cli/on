# Publish and use a recipe

Recipes package reusable workflow steps with declared inputs and secrets. A published recipe version is immutable;
workflows refer to an exact version. Recipes are globally visible to signed-in users, so review executable recipe
code before using it.

## 1. Create a recipe

Open **Recipes** and choose **Publish recipe**. Enter a slug such as `container-build` and a display name such as
`Container build`. The namespace is derived from your OIDC preferred username and retained for your account.

Paste this recipe YAML:

```yaml
inputs:
  image:
    type: string
    required: true

env:
  IMAGE: ${inputs.image}

steps:
  - id: build
    name: Build image
    run: docker build --tag "$IMAGE" .
```

The recipe input is data. It is bound to an environment variable, then quoted as a shell variable in `run`; it is
not pasted into shell source.

## 2. Validate and publish

Use the editor's validation, then save the version. The registry assigns an immutable version, for example
`ada/container-build@v1`. Editing the recipe creates a later version; it does not change `v1`.

## 3. Call the recipe from a workflow

Create a workflow and use the published version. Every recipe workflow has `with` and `secrets` objects; use an
empty `secrets` object when the recipe has no secret inputs.

```yaml
id: build-app
name: Build app

on:
  events: [image.requested]

using: ada/container-build@v1
with:
  image: example.invalid/team/app:1.0
secrets: {}
```

Validate and save the workflow, then use **Run now** to test the pinned recipe with a matching runner. Publish the
workflow when it is ready for domain-event triggers. Configure HTTP ingress and event production with a
[connector](../how-to/connectors.md). Replaying an incoming-event receipt publishes a new event; it does not rerun a
workflow. Use **Run now** or the workflow run API to execute the workflow again.

To pass a secret, declare it separately from ordinary inputs and map it through the calling workspace's secrets store:

```yaml
# In the recipe:
secrets:
  registryToken:
    type: string
    required: true

steps:
  - id: publish
    env:
      REGISTRY_TOKEN: ${secrets.registryToken}
    run: npm publish
```

```yaml
# In the workflow:
secrets:
  registry_token: ${secrets.REGISTRY_TOKEN}
```

For a binary file secret, declare `type: file`; the recipe receives its path under the run's `secrets` directory,
outside `wd`. Do not print secrets or include them in outputs, artifacts, or caches. Recipe-level `env` is inherited by
all steps; step-level `env` overrides it.
For named recipe functions, call the selected export with `function: <name>`. See the [recipe syntax reference](../reference/recipe-syntax.md) for contracts and nested calls.
