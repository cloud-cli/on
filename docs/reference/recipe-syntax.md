# Recipe syntax reference

Recipes are globally published, immutable versions of reusable workflow steps. The editor stores the recipe display
name and slug separately from the YAML. A workflow calls a pinned version using `namespace/slug@vN`.

## Inputs, secrets, and shared environment

Recipe inputs and secrets are separate top-level maps. An input declaration supports a JSON Schema type, `required`,
and `default`. Secrets support `type: string` or `type: file`, plus optional `required`.

```yaml
inputs:
  image:
    type: string
    required: true
  imageTag:
    type: string
    default: latest

secrets:
  serviceToken:
    type: string
    required: true
  credential:
    type: file

env:
  IMAGE: ${inputs.image}
  IMAGE_TAG: ${inputs.imageTag}
  SERVICE_TOKEN: ${secrets.serviceToken}

steps:
  - id: build
    run: docker build --tag "$IMAGE:$IMAGE_TAG" .
  - id: sign
    run: ./sign.sh "${secrets.credential}"
```

`env` applies to every recipe step. Explicit step-level `env` takes precedence over recipe `env`, which in turn takes
precedence over workflow-level `env`. Expressions in recipe `env` can reference the recipe's `inputs` and declared
`secrets`.

The workflow caller passes ordinary values through `with` and workspace secret references through `secrets`:

```yaml
using: ada/publish@v1
with:
  image: ghcr.io/acme/app
secrets:
  serviceToken: ${secrets.SERVICE_TOKEN}
  credential: ${secrets.SIGNING_KEY}
```

An omitted input with a `default` uses that default. A missing required input or secret is rejected when saving the
workflow. Secret values are never stored in the recipe definition or workflow revision; only authorized workspace
secret references are pinned.

`type: file` expects a binary workspace secret stored using the binary-file secret option. During a run, it is written
with owner-only permissions under the run's `secrets` directory, outside `wd`, and exposed to the recipe as the path
`${secrets.credential}`. Container steps receive that directory as a read-only bind mount. The directory is removed
when the job finishes. Do not print, return, artifact, or cache secrets or secret files.

## Named functions

A recipe may export multiple functions with `functions`. Each function still declares object-valued JSON Schema
`inputs` and `outputs`, and non-empty `steps`. Optional `returns` maps output properties to supported expressions.
Use `function: build` in the workflow to select an export. If there is a `main` export it is the default; if there is
exactly one differently named export, it is selected automatically. Otherwise `function` is required.

```yaml
functions:
  build:
    inputs:
      type: object
      required: [image]
      properties:
        image: { type: string }
    outputs:
      type: object
      properties: { image: { type: string } }
    steps:
      - id: build
        run: docker build --tag "${inputs.image}" .
```

## Nested function calls

Recipe steps may call an exact pinned function:

```yaml
steps:
  - id: package
    call: ada/archive@2#build
    with:
      directory: ${inputs.source}
    secrets: {}
```

Nested call targets use `namespace/slug@<integer-version>#<function>` (without the workflow-level `v` prefix).
`with` must be an object. Optional `secrets` maps the called function's secret inputs to aliases already available to
the parent function. Calls are validated and pinned into the consuming workflow revision; recursive call graphs and
nesting deeper than 16 are rejected.

Calls execute inline in the parent job and share its worker sandbox. Their attempts and outputs are visible in run
details, but they are not separate workflow jobs and do not provide exactly-once side-effect guarantees.
