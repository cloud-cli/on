# Create and manage an HTTP connector

A connector accepts an HTTP request at a private tokenized URL, evaluates a restricted YAML definition, and publishes
the final step's `{ type, data }` as a workspace domain event. Event subscriptions determine whether any workflow
receives that event. A receipt is not a workflow run.

## Connector definition

```yaml
kind: connector
id: deployment-hook
name: Deployment hook
steps:
  - id: normalize
    eval: |
      ({
        type: "deployment.completed",
        data: {
          environment: String(body.environment),
          revision: String(body.revision),
          requestId: headers["x-request-id"]
        }
      })
```

The top-level keys are exactly `kind`, `id`, `name`, and `steps`. `kind` must be `connector`; IDs and step IDs are
unique lowercase slugs; the name must be nonempty. There must be 1–32 steps. Each step contains only `id` and `eval`;
`run` steps are not supported. Expressions are limited to 8,192 characters and the YAML document to 256,000
characters. The final step must evaluate to an object with only `type` and `data`, where `type` is a lowercase
namespaced event type and `data` is a plain JSON object (up to 256 KiB serialized).

The restricted expression context contains `input` (an object with `contentType` and `body`), `body` as an alias for
`input.body`, sanitized/allowlisted `headers`, and `steps` containing outputs of earlier steps. Body is parsed JSON
for JSON content types; other valid UTF-8 bodies are text, and binary bodies are represented as base64 data and byte
length. Expressions support literals, property access, arrays/objects, operators, conditionals and templates. Calls
are restricted to `String`, `Number`, `Boolean`, `JSON.parse`, `JSON.stringify`, and bounded data-string methods:
`toString`, `toLowerCase`, `toUpperCase`, `trim`, `slice`, `substring`, `startsWith`, `endsWith`, `includes`,
`indexOf`, `lastIndexOf`, and `charAt`. Access to `constructor`, `__proto__`, and `prototype` is blocked. This is not
arbitrary JavaScript: there is no network access, filesystem, secret lookup, module loading, or shell execution.

## Manage and receive requests

Use `POST /api/v1/workspaces/{workspaceId}/connectors` with `id`, `name`, and `sourceYaml` to create a connector.
The YAML `id` and `name` must match the request fields. The response includes the tokenized ingress URL; treat it as
a credential. `GET` lists connectors, `GET /{connectorId}` reads one, `PUT /{connectorId}` updates its name and
definition, and `DELETE /{connectorId}` revokes it. These management routes require the corresponding workspace
webhook view/manage capability.

Send requests to `POST /webhooks/connectors/{token}`. A successful ingress returns `202`; processing and event
fanout are asynchronous. The endpoint accepts JSON, text, or binary bodies within the ingress size bound. Do not put
credentials or other secrets in event data: normalized domain-event data is not encrypted at rest.

## Receipts and replay

Workspace Incoming Events endpoints list and inspect receipts. Receipt detail omits captured input data. Replaying a
valid receipt with an active connector evaluates the stored request again through the connector's current revision
and publishes a new normalized domain event. The replay has its own replay identity; it is not a workflow/job rerun.
Use the workflow run API when the intent is to run a workflow again.
