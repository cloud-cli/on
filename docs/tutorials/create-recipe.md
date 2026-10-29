# Publish and use a recipe

Recipes package reusable workflow steps with a JSON Schema input contract. A published recipe version is immutable;
workflows refer to an exact version. Recipes are globally visible to signed-in users, so review executable recipe
code before using it.

## 1. Create a recipe

Open **Recipes** and choose **Publish recipe**. Enter a slug such as `container-build` and a display name such as
`Container build`. The namespace is derived from your OIDC preferred username and retained for your account.

Paste this recipe YAML:

```yaml
inputs:
  type: object
  required: [image]
  properties:
    image:
      type: string

steps:
  - id: build
    name: Build image
    env:
      IMAGE: ${inputs.image}
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
  github:
    events: [push]
    owner: acme
    repo: web-app

using: ada/container-build@v1
with:
  image: ghcr.io/acme/web-app:latest
secrets: {}
```

Validate and save the workflow, then use **Run now** to test the pinned recipe with a matching runner. Publish the
workflow when it is ready for automatic triggers.

To pass a secret, declare it in the recipe input schema with `writeOnly: true`, then map it through the calling
workspace's secrets store:

```yaml
# In the recipe input schema:
registry_token:
  type: string
  writeOnly: true
```

```yaml
# In the workflow:
secrets:
  registry_token: ${secrets.REGISTRY_TOKEN}
```

Use the secret in a recipe step through its declared input and `env`; do not print it or include it in outputs.
For named recipe functions, call the selected export with `function: <name>`. See the [recipe syntax reference](../reference/recipe-syntax.md) for contracts and nested calls.
