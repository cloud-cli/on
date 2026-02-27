# Incoming Events

At the core of this runner is a webhooks dispach system.

Every event is sent to our daemon as an HTTP request, with a JSON body, and can trigger one or more workflows.

## General configuration syntax

```yaml

on:
    <source>:
        <event-name>:
            secrets:
                - /path/to/secrets
                - /path/to/.env
            mappings:
                <field>: <path.to.value.in.json.payload>
            env:
                A_SECRET: ${secrets.A_SECRET}
                A_VALUE: ${inputs.A_VALUE}
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
            
            dispatch:
                - path/to/output.json

```

### Source

Any event trigger can be defined here.

For example, source can be `github`, for a GitHub incoming webhook, or `time`, for a time-based trigger.

### Event name

Defines a trigger within an event.

For example, if source is `github`, event can be `published`, for a GitHub push event.

### Inputs

Inputs are defined from the incoming JSON payload. The payload is parsed and made available as the `inputs` variable

### Mappings

These are shortcuts to make scripting easier.

After the JSON payload is parsed, these mappings are evaluated, and added to `inputs` as shortcuts for long/deep properties in the payload.

For example: a github publish event contains a lot of fields. We can define `image` from `package.package_version.package_url`

```yaml
mappings:
    image: ${inputs.package.package_version.package_url}
```

### Secrets

The daemon can fetch secrets from its host environment, or from a file.

## Sequence of operation

For every incoming event, these steps are followed:

- Parse and validate payload
- Load secrets
- Map inputs
- Populate env with secrets
- Populate env with additional workflow definitions (section `env`)
- Run steps
- Dispatch results

## Dispatch

After steps are executed, a list of one or more JSON files can be defined to dispatch new events.
These files are read one by one and sent back to the daemon as new events.
