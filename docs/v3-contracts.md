# V3 contract decisions — milestone 1

This document records reviewable decisions for **milestone 1 only** of
[`v3-implementation-plan.md`](./v3-implementation-plan.md). It is additive: it
does not change existing APIs, schemas, or runtime behavior. The proposal
[`v3.md`](../v3.md) is on the `v3` branch and is illustrative, not an API or
schema specification. Nothing below claims that the proposed v3 capabilities
are implemented.

For current product vocabulary—including the distinction between a workspace,
Stream, Thread, event, invocation, and run—see
[`v3-product-model.md`](./v3-product-model.md). This terminology supersedes
"channel" as the product-level name; existing channel tables/routes remain
compatibility details until a reviewed migration decision.

Status labels distinguish choices made here from work that depends on
infrastructure not yet selected or delivered:

- **Decided now** — contract direction to preserve during subsequent design and
  implementation.
- **Deferred** — decision requires an adapter, product policy, or operational
  evidence that is not available at this milestone. No dependent feature should
  imply a stronger guarantee in the meantime.

## 1. Immutable event contract

### Envelope — decided now

An event is a workspace-scoped immutable fact, distinct from an inbound
transport receipt, a consumer delivery, an invocation, and a run. The canonical
envelope is:

| Field            | Contract                                                                                              |
| ---------------- | ----------------------------------------------------------------------------------------------------- |
| `id`             | Globally unique occurrence identifier; assigned once and never reused.                                |
| `workspaceId`    | Authorization and event namespace. In the current implementation this is `teamId`.                    |
| `type`           | Stable, namespaced event type, for example `git.push` or `workflow.completed`.                        |
| `schemaVersion`  | Positive integer identifying the payload contract for this type.                                      |
| `source`         | Producer identity; descriptive provenance, not an authorization principal or deduplication namespace. |
| `occurredAt`     | Producer-observed occurrence time, not a delivery ordering key.                                       |
| `recordedAt`     | Server-assigned durable acceptance time.                                                              |
| `correlationId`  | Optional lineage/grouping identifier.                                                                 |
| `causationId`    | Optional immediate cause identifier.                                                                  |
| `idempotencyKey` | Optional producer-scoped logical occurrence key, unique within a workspace.                           |
| `data`           | JSON payload valid for `(workspaceId, type, schemaVersion)`.                                          |

Persisted event facts are immutable. Correcting an event means publishing a
new occurrence with explicit causal linkage, not updating the old fact.
`recordedAt` and the persisted event sequence support acceptance ordering;
timestamps and producer-supplied IDs are not cursors. Channel pagination cursors
are opaque and team/channel scoped. The sequence is a storage cursor, not an
external event identifier.

Events have a migrated, unique sequence populated before use and assigned to new
events on insert. Future-only subscriptions capture the current maximum sequence
in their registration statement. This removes reliance on mutable implicit
SQLite rowids. Reconnect-without-gap/duplicate behavior and production database
concurrency still require acceptance testing.

### Schema evolution and idempotency — decided now

Schema versions are per event type and begin at 1. A version's payload meaning
is immutable. A breaking payload or semantic change requires a new version;
consumers validate the exact version they declare and must not reinterpret an
unknown version as a compatible one. Additive optional fields may remain in a
version only where its schema explicitly permits them. No general automatic
up-conversion is promised; any future adapter must be explicit, versioned, and
observable.

An idempotency key identifies the same logical occurrence within a workspace,
independent of `source`. Reusing it with identical event type, schema version,
occurrence facts, and canonicalized payload resolves to the original event;
reusing it with conflicting facts is an error, never an update. Publishers
without a stable source occurrence key must not claim source-level duplicate
protection. Event identity, deduplication identity, and event type are separate
concepts.

### Payload safety — decided now

Event JSON is not inherently encrypted. Do not include credentials, tokens,
secret values, signatures, or unrelated sensitive personal data. Store
authorized secret references or appropriately protected external references
instead. Workspace authorization applies to event reads, delivery diagnostics,
and referenced data; identifiers alone do not grant access. Raw provider
receipts belong in a separately protected ingress boundary and must not be
copied wholesale into normalized domain events.

## 2. Subscription boundary and outcomes

### Start boundary — decided now

A newly created subscription begins **after** its registration boundary. It
does not consume retained earlier events unless an explicit, separately
authorized historical replay is requested. The decision is recorded per
subscription; changing a subscription affects future routing and does not
rewrite past delivery decisions. Each subscription has independent delivery
state. An event is not globally consumed by its first consumer.

Subscriptions bind a workspace, event type/schema compatibility, an immutable
subscription revision, and an exact workflow revision. Event publication is
independent of consumer availability; delivery is retryable and at least once.
An idempotent admission key prevents a retried delivery from creating a second
logical invocation. Re-evaluation under changed routing is an explicit new
operation, not ordinary retry.

### Observable dispositions — decided now

Keep these outcomes distinct in durable diagnostics:

| Outcome     | Meaning                                                                                                                                                            |
| ----------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `accepted`  | Producer event passed authentication/validation and was durably recorded.                                                                                          |
| `duplicate` | A matching idempotency identity already names the same event; return/link that occurrence. A conflicting duplicate is rejected.                                    |
| `rejected`  | Invalid, unauthorized, unsupported-schema, or otherwise inadmissible input; record a safe reason at the ingress boundary, without creating a trusted domain event. |
| `filtered`  | A valid event reached an applicable subscription but its recorded reaction condition did not match; no invocation is created.                                      |
| `unmatched` | No eligible subscription existed at the event's registration boundary. This is not the same as an event rejected by its producer or filtered by a consumer.        |
| `failed`    | Delivery/admission could not complete after its retry policy; preserve reason and allow an explicit operator action where authorized.                              |

The table defines semantic distinctions, not a requirement to use these exact
database enum values in all existing tables. A delivery's own lifecycle (for
example pending/claimed/admitted) is separate from ingress disposition. Error
views must be workspace-authorized and redact secrets and sensitive payloads.

### Schema-filter decisions — decided now

Validate the event against its declared type and schema version before
subscription matching. Unsupported or invalid payloads are rejected, not
silently filtered. A reaction condition that evaluates false is filtered.
Invalid canonical invocation inputs are rejected at admission. Workflow entry
conditions that intentionally decline valid input are recorded as filtered or
rejected according to a stable, documented condition policy; never report such
work as successfully executed. Exact error vocabulary for API responses is
deferred to the API contract work.

## 3. Definition revisions and identity

### Exact pinning — decided now

At invocation admission, capture the exact workflow revision and every
transitively referenced recipe/module revision and function identifier used by
that execution. A mutable alias or active revision may help resolve a new
request, but the resulting execution record stores the resolved immutable
references. Queued work does not switch to a newer active workflow on restart.
Unavailable or revoked pinned definitions fail visibly; they are not silently
replaced with current versions. Historical runs continue to refer to their
original stored revisions.

Existing foundations already persist workflow revisions and queued job
`workflow_revision`; recipes have published integer versions, with legacy
single-step recipes normalized to a `main` function. These facts are useful
compatibility anchors, not proof that transitive function pinning is complete.
The normalized immutable workflow revision stores the transitive reference list
and each referenced function's normalized inputs schema, outputs schema,
optional returns map, and steps under its exact reference key. Workers execute
these captured definitions, not a mutable alias or latest registry version;
runtime still checks the registry revocation state for each exact reference.

### Stable callable and call-site identity — decided now

Keep identity layers distinct:

1. **Definition identity:** stable workflow ID, recipe/module ID, and exported
   function ID, each paired with an immutable revision where applicable.
2. **Call-site identity:** an author-assigned stable step/call-site ID within
   its containing workflow revision or function revision. Renaming display
   text must not change it.
3. **Call-instance identity:** a unique execution path composed from the
   parent invocation, call-site ID, and any repeated/loop or matrix coordinates.
4. **Attempt identity:** a distinct immutable identity for each execution
   attempt at that call instance.

Two calls to the same function remain distinct call instances. Aliases are
resolution conveniences only; historical execution uses the fully resolved
IDs/revisions and call path. Existing step IDs are the compatibility source
for stable call-site IDs where possible.

### Initial nested recipe-call contract — decided now

The existing `functions` recipe shape remains the export mechanism. A nested
call is a recipe step with a required stable `id`, a `call` target written as
`namespace/slug@<integer-version>#<function-name>`, and a `with` object for
ordinary input bindings. An optional `secrets` object maps write-only function
inputs to workspace secret references, using the same rules as top-level
workflow recipe bindings. Nested calls use the existing authenticated,
globally-readable published recipe registry; they do not introduce private
recipe visibility or widen access beyond existing top-level `using` calls.
No mutable version aliases are accepted for nested calls in this slice. A
target must resolve to a published, non-revoked exact integer version. All
secret resolution remains scoped to the parent workflow's authorized
workspace, and a recipe cannot read secrets except through explicit mappings.

At publication, validate each target function's declared JSON Schema inputs,
reject missing/unknown inputs and secret misuse, and reject recursive call
graphs and nesting deeper than 16. The complete transitive set of exact
`(namespace, slug, version, function)` references is pinned into the workflow
revision together with the immutable function definitions used for that lock;
later publication or alias changes cannot affect queued work. A
missing or revoked pinned dependency fails visibly rather than falling forward.

A function's `outputs` is the JSON Schema contract. Its optional `returns` object
maps output property names to expressions evaluated after its steps complete;
every required schema property must have a return expression. The resulting
object is validated against the output schema before the call step publishes
`steps.<call-id>.outputs`. If there is no `returns` map and no required output
properties, the function returns an empty object. The initial expression subset
is a single property path rooted at `inputs`, `steps`, `job`, `matrix`, or
`github`; string interpolation and secret reads are rejected. Runtime validates
evaluated call inputs and returned values against their declared schemas.

Calls execute inline, serially, in the parent run's sandbox and captured input
context. Each call step is one stable call site; its result is exposed as
`steps.<call-step-id>.outputs` only after output-schema validation. A call
failure fails that parent step and follows the parent's existing retry policy;
the runtime does not claim exactly-once effects or independently retry nested
effects. Call attempts are independently inspectable under the parent job with
a stable call path derived from parent call path plus call-site ID and matrix
coordinates, and immutable attempt number. They must not be represented as
independent workflow jobs or confuse a nested function call with an addressed
workflow request. Loops are not supported in this initial slice.

The first implementation must add compatibility tests showing that legacy
top-level `inputs`/`steps` remain the `main` function at the same published
integer version, and that old queued references do not resolve to a newer
recipe version. The nested-call inspection schema/API is additive and must not
rewrite existing step-attempt records.

## 4. Admission is not execution

### Invocation versus run — decided now

An **invocation** is the durable decision to request one workflow operation
with a caller/source, authorized workspace, canonical inputs, causal context,
and pinned definitions. It can be accepted, filtered, rejected, or fail
admission. A **run** is an execution of an accepted invocation and can be
queued, running, succeeded, failed, or cancelled. Neither event receipt nor
invocation acceptance means a worker has started or the operation completed.

Retries of delivery/admission return the same logical invocation when their
idempotency identity is unchanged. An intentional new run/retry request creates
a separately identifiable attempt or derived invocation with lineage; it must
not mutate the original record. API/tool request, event reaction, and internal
request paths should converge on the same authorization, validation,
filtering, pinning, and admission semantics. Their transport acknowledgements
must state acceptance, not imply completion.

Exact request resource shape, run-attempt ownership, synchronous wait behavior,
and cancellation/result protocol are deferred to the corresponding API and
execution milestones.

An addressed-request event records durable intent, not proof that queue
admission finished. Admission therefore needs its own durable pending/admitted/
failed state. Recovery queries only pending admissions, uses stable per-variant
dispatch keys, records partial progress idempotently, and leaves transient
failures eligible after restart. Successfully admitted requests must not be
re-expanded or re-published on every poll. A permanent pinned-definition or
validation failure is recorded as failed with a safe diagnostic, distinct from
the worker run's eventual status.

### Agent workflow tools — decided now

An agent principal's workspace access, workflow-discovery result, or generic
`runs.dispatch` capability does not implicitly grant access to every workflow
as a tool. A tool invocation requires an explicit workspace-scoped grant naming
the agent principal and target workflow; admission checks that grant and the
ordinary workspace dispatch capability on every request. The grant exposes
only the workflow's declared input contract, not workflow source, secrets, or
other workspace resources. The durable request records the actor principal and
tool/workflow identity as provenance, while input values stay protected as
required by the workflow contract. Tool acknowledgement is an accepted request
handle, never a claim that the run completed; results are fetched separately
through normal workspace authorization. Subscription configuration,
concurrency limits, cancellation, and result protocol details are deferred to
milestone 6.

## 5. Checkpoint references and retention

### Contract boundaries — decided now

A checkpoint reference is metadata, not the checkpoint bytes. When supported,
it must identify the immutable object/version, storage adapter, integrity
digest, captured boundary/manifest, compatible runtime context, creation time,
and retention/availability status. A reference is usable only after the
content is durably stored and integrity-verified. Missing, expired, or
incompatible content is reported as unavailable; never substitute a newer
snapshot or mutable source.

Checkpoint capture is limited to a declared execution sandbox boundary. It
does not claim to capture process memory, arbitrary host state, remote services,
or external effects. Starting and post-execution/failed-state snapshots are
separate references. A checkpoint upload failure must not erase execution
outcomes or evidence and must not cause a completed command to be rerun.

Never snapshot injected secret values or credentials. Secret references and
version identifiers may be recorded only under existing authorization rules;
resolve values again through the approved secret service when executing.
Filter logs, outputs, manifests, and diagnostic payloads for secret material.

### Deferred pending infrastructure

The storage adapter and object lifecycle, encryption/access model, durable
cross-worker restoration, filesystem fidelity, size limits, verification
protocol, retention periods, legal deletion/hold behavior, and user-visible
expiry controls are **not decided**. Until those are established and tested,
the contract does not promise durable replay or any default retention period.
Local artifacts or current successful-run file capture are not equivalent to
step-level durable checkpoints.

## 6. Side effects and interruption

### At-least-once execution — decided now

Event delivery, worker recovery, and effectful steps must be treated as
at-least-once across crashes, timeouts, lease expiry, and lost acknowledgements.
Do not claim exactly-once side effects. For each logical external operation,
use a stable operation/idempotency key where the external system supports it;
persist the operation identity and known result. If a request may have reached
the external system but its response was lost, mark the outcome uncertain and
reconcile or require an explicit safe operator decision. Do not blindly repeat
an operation whose effect is unknown.

Interruption preserves the last durable attempt state. A lease expiry or
worker restart can lead to another attempt; fencing protects coordinator writes
where supported but cannot undo an already-issued external action. Step-attempt
records are immutable; a retry is another attempt linked to the prior one.
Checkpoint persistence or downstream notification retries independently of
the completed step and cannot itself trigger recomputation of that step.

For durable step-attempt visibility, start and completion are separate
immutable facts: an additive start-marker row is persisted before driver
invocation, while the existing terminal attempt row remains the completion
fact. Readers may expose a derived view by pairing those records. A start marker
without completion is `interrupted_or_unknown`; it does not distinguish a dead
worker from work still in progress. This visibility does not provide replay,
resume, checkpoint, or exactly-once guarantees.

### Deferred

The effect taxonomy, per-driver interruption guarantees, external-operation
reconciliation adapters, cancellation cut-off semantics, retry budgets/backoff,
and UI/operator workflow for uncertain effects require driver/provider
capabilities and are deferred. Until declared and enforced, arbitrary shell
steps are non-deterministic and unsafe to replay automatically when they may
have side effects. “Replay” must not be presented as exactly-once or guaranteed
reproduction.

## 7. Compatibility, migration, and rollback

### Compatibility rules — decided now

- Preserve current workflow IDs, stored revisions, recipe IDs/versions,
  queued-job pins, and historical run/step records as interpretable data.
- Do not rewrite historical execution records to fit a newer envelope or
  definition. Add explicit readers/adapters when old representations need to be
  displayed or consumed.
- Legacy recipe step sequences receive a compatibility `main` entry point for
  their existing published version; migration must not resolve old runs to a
  newly published recipe version.
- Existing provider-triggered workflow behavior must remain supported while
  provider adaptation is migrated to normalized events. Do not convert or
  disable triggers until equivalent authorization, filtering, and identity
  semantics are covered by tests.
- Preserve existing queue semantics and API behavior while additive event,
  invocation, subscription, and checkpoint tables/APIs are introduced.
- Workspace scoping and existing authorization checks remain mandatory for
  migrated and new records. Never infer authorization from an identifier.

### Migration and rollback method — decided now

Use additive, versioned migrations with explicit schema-migration records;
prefer expand/dual-read-or-write/verify/cutover/contract sequencing. Backfill
only when old data can be mapped without inventing facts; record provenance for
derived values. Make each migration restart-safe and validate invariants before
cutover. Keep old readers/routes/workers available through a verified
compatibility window. Do not drop or irreversibly transform legacy columns or
records in the same release that first introduces their replacement.

Rollback before cutover disables the new path and returns reads/writes to the
legacy path. After new-format records exist, rollback must preserve them and
either keep a compatible reader or provide an explicit reversible mapping;
never delete accepted events, invocations, attempts, or history to restore an
older binary. A migration that cannot support safe application rollback must
be gated as an operationally irreversible release with backup/restore and
forward-fix procedures approved before deployment. Migration tests must cover
both an existing database and a fresh install, repeat application, and old-data
interpretability.

### Current-state evidence and gaps

The repository currently has versioned workflow revisions, recipe versions,
queued-job revision pins, team-scoped domain events with schema version and
workspace idempotency uniqueness, event subscriptions/deliveries with a
high-water event sequence boundary, and durable step-attempt metadata. See
`src/workflows.ts`, `src/recipes.ts`, `src/queue.ts`, `src/domain-event-repository.ts`,
`src/domain-event-delivery-repository.ts`, and migrations `015`–`026` in
`src/migrations.ts`. `docs/domain-events.md` documents current payload privacy.

These are partial foundations, not completion of milestone 1 or v3. Gaps
include a formal versioned event schema registry/validation contract, a durable
public cursor and explicit unmatched/rejected diagnostics, common invocation
resources distinct from jobs, transitive function revision locks and stable
nested call identities, durable checkpoint object storage/retention, and
effect-aware retry/reconciliation semantics. Compatibility/rollback choices
above need review and migration compatibility tests before dependent schema or
runtime changes. No implementation change is made by this document.

Migration 018 intentionally fails before adding the subscription-identity
unique index if duplicate identities exist. The migration does not auto-merge
subscriptions or their delivery rows: delivery histories can conflict, and
silently choosing one could lose retries or outcomes. Before deployment,
operators must run the migration's duplicate-identity grouping query and
reconcile affected subscriptions/deliveries using an approved, auditable
procedure; then rerun migrations. Automatic consolidation is deferred until
delivery-state merge semantics are explicitly designed and covered by tests.

## 8. Deferred decisions index

These matters remain open pending the named infrastructure or dependent
milestone; this document does not imply a commitment to a specific product
surface:

- **Event infrastructure:** schema registry/validator implementation,
  durable public sequence/cursor format, event/receipt retention and deletion.
- **Subscription/admission:** API error vocabulary, explicit historical
  redelivery controls, cursor compaction, diagnostics UI, invocation resource
  and sync/async response shape.
- **Callable definitions:** dependency-lock digest, future mutable alias
  resolution/collision handling, private recipe visibility, and exact path
  encoding for loops/repeated calls (loops remain unsupported initially).
- **Checkpoint infrastructure:** adapter, encryption and storage ACLs,
  retention defaults, quotas, garbage collection, restoration fidelity, and
  expiry/hold policy.
- **Effects/runtime:** effect classification, safe retry capability matrix,
  reconciliation, cancellation guarantees, and interruption behavior per
  execution driver.
- **Rollout operations:** release-specific migration compatibility window,
  backup/restore procedure, and approval for any irreversible cutover.
