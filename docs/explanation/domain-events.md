# Connectors, domain events, and workspace data

On keeps inbound transport records separate from normalized domain facts and workflow execution:

1. A **connector receipt** records an inbound request and its validation outcome.
2. An authenticated connector may publish a **domain event**, an immutable normalized fact.
3. A subscription or workflow trigger records delivery/admission work.
4. An accepted invocation is queued as one or more **runs**, executed by authorized runners.

These stages have distinct identities and outcomes. An ingress acknowledgement means the request was accepted;
it does not mean a worker has finished the job.

## Connector ingress receipts

Connectors authenticate and validate incoming requests before publishing normalized events. Receipts and domain
events remain separate records, so delivery can be retried without changing the event's identity. Workspace
connector registrations and credentials are independently revocable.

## Domain events

`domain_events` stores immutable workspace-scoped facts. It is separate from the protected connector ingress
receipt inbox. Delivery tracking is stored separately from each event so consumers can
recover independently.

Each connector defines its own authentication, validation, normalization, and idempotency rules. Normalized events
should contain only fields needed by consumers, never credentials, signatures, or unbounded raw request data.

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
