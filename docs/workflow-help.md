# Workflow Documentation

This short reference is embedded in the app's workflow help panel. For the full guides, use the tutorials,
how-to guides, and references listed in `docs/README.md`.

## Tutorials

### Your First Workflow

Create a workflow draft in the editor, validate it, and use **Run now** to test the saved draft. Publish and enable
it before expecting webhook or schedule triggers to start new runs.

```yaml
id: hello
name: Hello
on:
  github:
    events: [push]
steps:
  - id: greet
    env:
      NAME: ${inputs.name}
    run: printf 'Hello %s\n' "$NAME"
```

### Environment and Expressions

Use `${...}` expressions in supported value fields such as `env`, and pass values to shell scripts through
environment variables. `run:` is sent to the shell unchanged.

| Scope     | Available data                                    |
| --------- | ------------------------------------------------- |
| `inputs`  | Normalized webhook or manual-run input values.    |
| `env`     | Runner, workflow, and earlier environment values. |
| `secrets` | Secrets authorized for the workspace and job.     |
| `steps`   | Earlier step status and outputs.                  |
| `files`   | Workspace-bound file helpers in expressions.      |

### Docker Volumes and Trust

`volumes` and `dockerArgs` can expose host files or change container isolation. Use these options only in trusted
workflows on a runner configured for that trust level.

```yaml
steps:
  - id: sign
    image: alpine:latest
    volumes:
      - /var/lib/runner/signing:/signing:ro
    run: ./sign.sh /signing/key
```

### Binary Secrets

Store a binary secret through workspace settings and write it to the job workspace with `secretFiles`. Do not
include secret files in artifacts or caches.

```json
{
  "value": "<base64 file bytes>",
  "encoding": "base64",
  "originalName": "release.keystore"
}
```
