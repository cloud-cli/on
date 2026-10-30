# Create and manage an HTTP connector

A connector accepts an HTTP request at a private tokenized URL, evaluates a restricted YAML program, and publishes the
events emitted by that program as workspace domain events. Event subscriptions determine whether any workflow receives
an event. A receipt is not a workflow run. A program may emit multiple events; emitting none is valid.

## Connector definition

```yaml
run: |
  if (inputs.status === "complete") {
    emit("deployment.completed", {
      environment: String(inputs.environment),
      revision: String(inputs.revision),
      requestId: headers["x-request-id"]
    });
  }
```

The YAML source has a single top-level `run: |` program. Connector ID and name are metadata supplied separately by the
management UI/API; they do not belong in the YAML. At runtime, `inputs` is a parsed JSON object, `body` is the raw
request body as a Buffer, `headers` contains request headers except host/origin and proxy-routing metadata,
`secrets.WEBHOOK_SECRET` is the configured webhook
secret, `verifyBody(body, signature)` is available for checking a signature, and `emit(type, data)` emits a normalized
domain event. Other headers, including authorization/cookie headers, remain available to the connector program. Event
`data` should contain only suitable domain data; avoid forwarding credentials or other secrets.

Programs are interpreted by a restricted AST interpreter. It supports block, `if`, expression, and `throw`
statements; it does not execute `Function` or arbitrary JavaScript. Use the runtime-provided verification and emission
helpers rather than assuming general-purpose APIs are available.

Previously published step-based connector definitions remain executable for compatibility if they have no webhook
secret. New saves and publishes require the `run` format. Legacy connectors with a configured webhook secret fail
closed and must be rewritten to the `run` format to use `verifyBody`; their saved receipt replays require that update as
well.

A GitHub integration can be expressed in connector YAML, including request verification and mapping GitHub payloads to
domain events, but the connector runtime itself has no GitHub-specific assumptions or behavior.

For example, this connector validates a GitHub push request and emits a normalized event. The GitHub-specific header
names and payload mapping are choices in this YAML, not behavior built into the runner:

```yaml
run: |
  if (!verifyBody(body, headers["x-hub-signature-256"])) {
    throw new Error("Invalid signature or payload.");
  }

  if (headers["x-github-event"] === "push") {
    emit("github.push", {
      ref: inputs.ref,
      repository: inputs.repository.full_name,
      commits: inputs.commits,
      revision: inputs.after
    });
  }
```

Subscribe a workflow to `github.push` to receive the emitted event data in `inputs.data`:

```yaml
id: deploy-push
name: Deploy push
on:
  events: [github.push]
steps:
  - id: deploy
    env:
      REVISION: ${inputs.data.revision}
      REPOSITORY: ${inputs.data.repository}
    run: ./deploy "$REPOSITORY" "$REVISION"
```

## Manage and receive requests

Create and manage connectors through the workspace connector UI/API. The connector ID and name are outer metadata, and
the YAML source is stored as the connector definition. Treat the tokenized ingress URL as a credential.

Send requests to the connector's ingress URL. A successful ingress is accepted for processing; event fanout is
asynchronous. Do not put credentials or other secrets in event data: normalized domain-event data is not encrypted at
rest.

### Optional webhook secret

The tokenized webhook URL and webhook secret are separate credentials. The URL routes a request to the connector; the
secret can be used by the connector program to verify request signatures. The secret is generated or rotated through
the connector management UI and is shown only once. Store it securely. Rotating it invalidates the previous secret.

For example, a sender might provide a signature in a vendor-neutral header:

```text
X-Webhook-Signature: <signature computed over the exact raw request body>
```

Pass the raw `body` and the selected header's signature value to `verifyBody(body, signature)`. The generic helper
checks HMAC-SHA-256 over the exact body bytes in the `sha256=<hex>` format using `secrets.WEBHOOK_SECRET`; it does not
apply a timestamp window or deduplicate deliveries. The connector YAML chooses the signature header and maps any
vendor-specific payload. The runtime does not automatically impose vendor-specific signature or delivery behavior.
