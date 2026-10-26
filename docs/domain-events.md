# Domain event data policy

`domain_events` stores immutable workspace-scoped domain facts. It is separate from
`incoming_events`, which is the encrypted inbound webhook receipt inbox. Domain
event `data_json` is ordinary JSON and is **not encrypted** by this foundation;
publishers must omit credentials, tokens, personal data not needed by consumers,
and other secrets. Applications must authorize reads by workspace. Do not expose
these records through an API without an explicit access-control and data-retention
review. Idempotency keys are unique per workspace, regardless of source label, so
publishers cannot bypass duplicate protection by changing `source`. Consumer
delivery tracking is persisted separately from the immutable event.

The GitHub connector currently normalizes verified `push` webhooks to schema
version 1 of `git.push`. Its data contains only repository identity, owner/name,
ref, commit SHA, and operation (push/delete); it does not copy the raw provider
payload, commit author, message, or delivery signature. When GitHub omits the
commit timestamp, `occurredAt` uses the original ingress receipt's persisted
`received_at` time, so retries retain identical event facts without fabricating
an event time; `recordedAt` remains the event-store acceptance time.
