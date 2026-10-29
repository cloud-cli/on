# Webhooks, domain events, and workspace data

On keeps inbound transport records separate from normalized domain facts and workflow execution:

1. A **webhook receipt** records a provider request and its validation outcome.
2. A verified provider connector may publish a **domain event**, an immutable normalized fact.
3. A subscription or workflow trigger records delivery/admission work.
4. An accepted invocation is queued as one or more **runs**, executed by authorized runners.

These stages have distinct identities and outcomes. A `202` webhook response means ingress accepted the request;
it does not mean a worker has finished the job.

## Incoming webhook receipts

The ingress checks provider signatures against the original request body bytes before matching workflows.
Verified GitHub and Gitea push hooks normalize provider payloads and capture a bounded receipt. Invalid signatures
are rejected with `401` before a receipt is stored. A verified receipt may then be matched, filtered, left
unmatched, queued, or marked failed. Workspace webhook URLs and signing secrets are independently revocable.

## Domain events

`domain_events` stores immutable workspace-scoped facts. It is separate from `incoming_events`, which is the
protected inbound webhook receipt inbox. Delivery tracking is stored separately from each event so consumers can
recover independently.

The current GitHub and Gitea connectors normalize verified push payloads to schema version 1 of `git.push`. The
event includes repository identity, owner/name, ref, commit SHA, and operation (push/delete); it does not copy the
raw provider payload, commit author, message, or delivery signature. A provider delivery ID is used for
idempotency where present. If a commit timestamp is absent, the persisted ingress receipt time is used as the
occurrence time, so retrying does not invent a new event time.

Event payload JSON is not inherently encrypted. Do not include tokens, signatures, secret values, or unrelated
personal data. Readers and delivery diagnostics must remain scoped to the owning workspace.

## Subscriptions and history

A new subscription starts after its registration boundary; it does not consume retained earlier events unless an
explicit replay operation is requested. One event may have independent delivery state for multiple consumers.
Outcomes such as filtered, unmatched, duplicate, and failed delivery are distinct from a workflow run's terminal
status.

Streams and Threads are workspace UI/history concepts, not aliases for events or runs. A Stream can present event
and execution cards; the durable event, delivery, invocation, and run records remain the sources of truth. Current
implementation and API details are in the [HTTP API reference](../reference/http-api.md) and
[OpenAPI contract](../../openapi.json).
