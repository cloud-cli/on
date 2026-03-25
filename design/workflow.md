# Workflow Design

This is a task runner using webhooks to process incoming events.

Every event is sent to a daemon as an HTTP request, with a JSON body, and can trigger one or more workflows.

Every workflow is a set of steps that run inside a docker container.

All steps run in the same workspace folder.

The current folder is mounted as a volume at /workspace by default. That can be changed by specifying a volume with `.` as the host path.

## General configuration syntax

```yaml
on:
  <event-name>:
    secrets:
      - /path/to/secrets
      - /path/to/.env
    mappings:
      <field>: <path.to.value.in.json.payload>
    env:
      A_SECRET: "${secrets.A_SECRET}"
      A_VALUE: "${inputs.some.value}"
    defaults:
      image: <docker-image>
      volumes:
        .: /home
        /dev/shm: /dev/shm
      args:
        net: host
        dns: 1.2.3.4
    steps:
      - pnpm i
      - pnpm run build
      - pnpm run release
      - echo '::set-output::name' $?
    triggers:
      - path/to/output.json
```

### Source

Any event trigger can be defined here. Any event source is mapped to a key in the incoming webhook payload.
For example:

Given the payload `{ published: { value: 123 } }`

And the workflow

```yaml
on:
  published:
    steps:
      - echo ${inputs.value}
```

Then `inputs` is set to the payload value of `published`, which contains `value`.

### Secrets

The daemon can fetch secrets from its host environment, or from a file.

### Inputs

Inputs are defined from the incoming JSON payload. The payload is parsed and made available as the `inputs` variable

### Mappings

These are shortcuts to make scripting easier.

After the JSON payload is parsed, these mappings are evaluated, and added to `inputs` as shortcuts for long/deep properties in the payload.

For example: from a GitHub webhook event that contains a lot of fields, we can define `image` from `package.package_version.package_url`

```yaml
mappings:
  image: ${inputs.package.package_version.package_url}
```

### Environment variables

After resolving secrets and mappings, we proceed to resolve env variables from template strings or literal strings.

An env variable is interpreted a JS template string, with `${value}` syntax used to interpolate values from `inputs` or `secrets`.

## Sequence of operation

For every incoming event, these steps are followed:

- Parse and validate payload
- Load secrets
- Map inputs
- Populate env with secrets
- Populate env with additional workflow definitions (section `env`)
- Create a temporary working directory
- Add a volume to defaults at `/workspace`, or a custom path, if a volume with a host path `.` is defined in the workflow
- Run steps:
  - For every step, either a string, or a step definition is accepted.
  - If string, run with the defaults defined in the workflow
  - If a definition, merge defaults into it, and run the step
  - The step is a shell command, executed inside a short-lived container
- Trigger new events

## Triggers

After steps are executed, a list of one or more JSON files can be defined to trigger new workflows.

These files are read one by one and sent back to the daemon as new events.
