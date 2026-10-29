# Recipe syntax reference

Recipes are globally published, immutable versions of reusable workflow steps. Their source contains input/output
contracts and executable steps. The editor stores the recipe display name and slug separately from the YAML.

## Legacy `main` function

A recipe can define `inputs` and `steps` at the top level. This form is normalized as the `main` function and
remains supported:

```yaml
inputs:
  type: object
  required: [image]
  properties:
    image:
      type: string

steps:
  - id: build
    env:
      IMAGE: ${inputs.image}
    run: docker build --tag "$IMAGE" .
```

## Named functions

Alternatively, export one or more functions. Each function requires object-valued `inputs`, `outputs`, and
non-empty `steps` fields. Optional `returns` maps output properties to supported single-path expressions.

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
      properties:
        image: { type: string }
    returns:
      image: ${inputs.image}
    steps:
      - id: build
        env:
          IMAGE: ${inputs.image}
        run: docker build --tag "$IMAGE" .
```

Use `function: build` in a workflow that calls this recipe. If there is a `main` export it is the default; if there
is exactly one differently named export, it is selected automatically. Otherwise `function` is required.

## Input schemas and secrets

`inputs` and `outputs` use JSON Schema Draft 7 and must declare `type: object`. Ordinary inputs are passed through
the workflow's `with` object. A secret input must be a string property with `writeOnly: true` and is mapped through
the workflow's `secrets` object:

```yaml
inputs:
  type: object
  required: [registry_token]
  properties:
    registry_token:
      type: string
      writeOnly: true
```

```yaml
using: ada/publish@v1
function: publish
with: {}
secrets:
  registry_token: ${secrets.REGISTRY_TOKEN}
```

Workflow `with` values cannot supply a write-only property. Secret values are scoped to the workspace and the
declared recipe alias; do not return them, log them, or copy them to artifacts.

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
`with` must be an object. Optional `secrets` maps the called function's write-only inputs to aliases already
available to the parent function. Calls are validated and pinned into the consuming workflow revision; recursive
call graphs and nesting deeper than 16 are rejected.

Calls execute inline in the parent job and share its worker sandbox. Their attempts and outputs are visible in run
details, but they are not separate workflow jobs and do not provide exactly-once side-effect guarantees.

## Publishing and version references

Create a slug and display name in **Recipes → Publish recipe**, then validate and save. The registry assigns the
publisher namespace and the next version. Workflow references use `namespace/slug@vN`, for example
`ada/container-build@v1`; this is an immutable pin. Publishing an edit creates a new version and does not change
existing workflow references.

The accepted shape is also described by [`recipe.schema.json`](../../recipe.schema.json). Only signed-in human
users may publish recipes. A platform administrator can revoke a version; revoked versions cannot be used for new
workflow resolution.
