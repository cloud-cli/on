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
