# Single-binary Go task runner: design and runtime decision

Status: proposed design, not an implementation. Source baseline: `0554f69` on `dev`.

## 1. Recommendation

Rewrite the **execution workers** as one Linux Go executable, using the existing authenticated runner lease API. Keep the coordinator responsible for workflow revisions, scheduling, authorization, secrets at rest, and persistence.

Make expression evaluation a versioned internal interface from the beginning:

1. For migration without rewriting workflows, implement a **restricted JavaScript-expression compatibility profile**, not a Node.js replacement. A Go JavaScript parser plus an explicitly controlled evaluator best matches the existing architecture and the requested minimal namespace.
2. If changing the authoring language is acceptable, use **CEL as the default expression language** for both interpolations and `eval:`. CEL is a better fit for a portable, language-independent runner contract than inventing an unspecified “generic runtime.” Expr is a strong alternative if Go-only integration matters more than cross-language portability.
3. Keep `eval:` an expression returning data. It is already not a general JavaScript script. Add a separate script-step feature only if actual workflows need statements, loops, or user-defined functions.
4. Use the same binary's private evaluation subcommand for hard resource isolation where needed. A single distributed executable does not require every evaluation to share the worker's address space.

The main cost is semantic compatibility and reliable job lifecycle handling, rather than Go process spawning. Merely embedding a JS engine and deleting globals would not reproduce the current behavior or establish the requested boundary.

## 2. Review scope and source map

Reviewed all tracked `.ts` files in `src/`, its subdirectories, `ui/`, and the three root build/test configurations, including all TypeScript tests: 17,558 lines at the baseline. Also reviewed the runner protocol/install documents, workflow syntax, and package scripts. Browser `.mjs` implementation files and production-stored workflows are not included in that complete TypeScript review; tests and TS imports reveal their integration boundaries, but a migration inventory must inspect the deployed workflow corpus separately.

### Execution code to replace

| Existing source                                                         | Go responsibility                                                                                     |
| ----------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------- |
| `src/worker-entry.ts`, worker branch of `src/index.ts`, `src/config.ts` | CLI, configuration, bootstrap, version                                                                |
| `src/api-worker.ts`                                                     | Enrollment, bounded concurrency, claims, heartbeats, lease renewal, events, drain/update lifecycle    |
| `src/runner-api.ts`, `src/runner-api-client.ts`                         | One typed HTTPS/JSON/SSE client                                                                       |
| `src/runner-credentials.ts`                                             | Credential bootstrap and private atomic persistence                                                   |
| `src/worker.ts`                                                         | Job setup, sequential steps, retries, conditions, outputs, reports, dispatch, cache/artifact handling |
| `src/safe-eval.ts`                                                      | Expression parser/evaluator, value interpolation, conditions, workspace helpers                       |
| `src/drivers/*.ts`                                                      | Systemd and process execution, including Docker command construction                                  |
| `src/worker-state.ts`, `src/signals.ts`                                 | Per-job cancellation and orderly shutdown                                                             |
| `src/timestamped-log.ts`, `src/logger.ts`, `src/debug.ts`               | Bounded timestamped logging and diagnostics                                                           |
| `src/secrets.ts`                                                        | Job-scoped secret values and encodings, redaction                                                     |
| `src/parser/matrix-expander.ts`                                         | Worker reconstruction of the assigned matrix variant                                                  |
| `src/plugins/*.ts`                                                      | Built-in lifecycle integration and replacement for JS plugin configuration                            |
| `src/runner-updater.ts`, `src/semver.ts`, `src/version.ts`              | Go binary release/update adapter                                                                      |
| `src/types.ts`, `src/workflow-constants.ts`                             | Wire DTOs, domain types, execution defaults                                                           |

### Coordinator and UI boundaries

- `src/server.ts`, `src/queue.ts`, `src/runner-registry.ts`, and `src/events.ts` define the real lease protocol. They are the integration targets, not code to link into the worker.
- `src/workflows.ts`, `src/migrations.ts`, `src/team-data-schema.ts`, and `src/db-client.ts` own normalized revisions and database access. `DATABASE_URL` currently identifies an imported JS database module; it is not a portable SQL DSN to carry into Go.
- `src/scheduler.ts` and `src/preprocessors/github.ts` remain coordinator-side. They also use expression evaluation, directly or via matrix tags, so a language migration reaches beyond the worker.
- Secret/API-key/workspace-webhook repositories, teams, OIDC, user preferences, push, AI help, and safe-return-URL handling remain coordinator responsibilities.
- `ui/run-view.ts` consumes reports, outputs, timestamps, parent IDs, and artifact paths. Dashboard and runner-management pages consume status, runtime, capabilities, and versions. Preserve these contracts rather than rewriting the UI.
- UI templates and authoring help need runtime-aware examples/diagnostics when a new expression profile is introduced. The AI authoring prompt includes the [workflow syntax reference](../reference/workflow-syntax.md), so stale syntax documentation also generates incorrect workflows.
- Existing tests cover useful examples, transport boundaries, and authorization, but many are SQL/source-string assertions. They are not a complete behavioral specification for a new runner.

### Resolve documentation drift before using it as a specification

The architecture sketch in `AGENTS.md` describes latest-definition joins and `job_attempts`. Current code pins `workflow_revision`, stores reports on `jobs`, and implements reruns as new jobs linked through `parentId`. The Go runner should follow current code and wire contracts.

[`runner-protocol-v1.md`](runner-protocol-v1.md) mixes implemented behavior and aspirations: logs are whole-step snapshots, files use `/files`, and update failure reporting uses `/runner/update/status`. Sequenced log chunks, `/artifacts`, and a full drain/status protocol are not implemented as described there.

## 3. Actual behavior that determines rewrite scope

### 3.1 Worker lifecycle

There are two entry paths: API-only `start-workers` and DB-connected `start-workers-legacy`. Both ultimately call `processJob`. Replace both deployments with API workers, including workers on the coordinator host; do not recreate the legacy SQL client in Go.

Current API defaults and timings:

- Local concurrency is clamped to 1–100; configuration defaults to five workers.
- Heartbeat every 15 seconds; server presence becomes offline after approximately 45 seconds.
- Claims return a 90-second lease; renewals run every 30 seconds.
- Idle fallback claims approximately every three seconds; SSE reconnect backs off to 30 seconds.
- Shell cancellation is polled every three seconds in addition to event-triggered cancellation.
- Signals stop claims and wait for active work. The API runner clears its heartbeat before that drain completes; the Go design should keep presence and lease maintenance alive while draining.

SSE is not durable. The broker's IDs are in-memory counters, not a replay log. Reconnect must reconcile through REST; sending `Last-Event-ID` alone cannot recover missed cancellations or updates.

### 3.2 Job execution

`processJob` resolves the matrix variant, constructs `inputs/env/secrets/steps/files`, publishes a pending-step report, evaluates workflow environment in declaration order, writes secret files, restores caches, calls plugins, executes steps, collects successful artifacts/caches, and publishes completion.

Preserve or explicitly version these details:

- Default timeout is 30 seconds per step. `retries` means additional attempts **per failed step**, not whole-job retry.
- Missing step IDs become `step-0`, `step-1`, etc.; names default to IDs.
- `run:` is passed directly to a shell. It is **not** expression-interpolated. `${inputs.name}` in a shell script is not a runner expression today, despite one introductory documentation example.
- Environment values, cache keys, plugin secret mappings, conditions, and expression-valued dispatch inputs are evaluated. Step names/images/volumes/Docker arguments are passed through in current worker code, despite broader comments/examples.
- A false step condition currently ends the step loop and marks all following steps skipped. This is a major compatibility decision: preserve for the legacy profile; use conventional skip-and-continue only under a new execution-semantics version.
- Conditions supplied as an array are OR, evaluated in order until one is truthy.
- `eval:` receives the job context, not `stepContext.env`. Step-local environment is computed but is not visible to its expression today. Correcting this requires an explicit migration decision.
- `eval:` may return a scalar, list, object, or null-like value despite `StepReport.outputs` being typed as a record. Dispatch `with` must produce a non-array object. Preserve structured values rather than stringifying all outputs.
- Dispatch takes precedence over `eval`, which takes precedence over `run`. The YAML parser does not actually enforce exactly one execution kind. New revisions should reject ambiguity; inventory existing revisions first.
- Matrix values become `MATRIX_*` environment entries and affect the workflow name. Worker context does not expose `matrix` directly. Matching currently relies on JSON serialization order; Go must compare the assigned dimensions structurally.
- Retry logs append locally and upload a replacement snapshot. The final step report contains the last attempt's result; it is not a complete attempt history.
- Plugin initialization/hook failures are logged without failing the job. The built-in integration sends GitHub commit statuses.

### 3.3 Important wire details

All worker requests use `/api/v1`, a runner bearer credential, and the lease token header on assignment operations. Identity and workspace grants remain server-authoritative.

| Operation              | Current behavior to match                                                                                                                   |
| ---------------------- | ------------------------------------------------------------------------------------------------------------------------------------------- |
| Enrollment             | `POST /runners/enroll`, one-time code, returns runner ID and bearer credential                                                              |
| Heartbeat              | `POST /runner/heartbeat`, version/runtime/capabilities/concurrency/activeJobs                                                               |
| Claim                  | `POST /runner/leases`, `204` means no job; response includes job, normalized workflow, lease token and `expiresInSeconds`                   |
| State/workflow/secrets | `GET /runner/leases/{id}` and `/workflow`, `/secrets`                                                                                       |
| Renewal                | `POST .../renew`, current response is `204`, not a new expiry payload                                                                       |
| Reports                | `PUT .../report`, complete snapshot; top-level `jobId` must be numeric to match server's strict comparison                                  |
| Logs                   | `POST .../logs`, whole snapshot, at most 1,000,000 JS string code units                                                                     |
| Files                  | `POST .../files`, `kind`, `action`, `cacheKey`, base64 `files`; at most 1,000 entries and 4,000,000 encoded content characters              |
| Completion             | `POST .../complete`, numeric outer `jobId`, terminal status, report; repeated identical completion can be accepted within the current lease |
| Dispatch               | `POST .../dispatch`, numeric job ID, step ID, target, object inputs; server deduplicates by source job and step                             |
| Release                | `POST .../release`; use only before any job side effects                                                                                    |
| Updates                | `GET /runner/update`, failure via `POST /runner/update/status`; success inferred from matching-version heartbeat                            |

Additional integration constraints:

- The claim body supplies tags, but the server selects using capabilities from the registered heartbeat. Initial heartbeat must precede claiming. New runtime capabilities must be reflected in scheduling, not just sent in claim bodies.
- Secret responses contain `{value, encoding}` records, even though the client declares a string map. Decode both that representation and historical string values.
- The generic HTTP body limit is 5 MiB. The worker's 50 MiB collection limit cannot actually be uploaded through the current API in one request. Define compatible limits first; streaming requires a coordinator protocol extension.
- Cache owner keys are already prefixed with workflow ID by the worker, then namespaced again by the server and truncated to 200 characters. Preserve old lookup behavior during migration; introduce a new cache namespace/version to correct this without silent misses or collisions.
- The API completion route emits a job-change event; intermediate report/log writes do not. UI refresh behavior is therefore not equivalent to the legacy worker's explicit event calls. Decide whether to add coordinator notifications before promising real-time progress.
- Current dispatch limits are 256,000 serialized bytes and five ancestry levels. The docs' “256 KiB” is approximate. The server resolves the target and its revision; the runner must not resolve it independently.

## 4. Proposed Go architecture

### 4.1 Deliverable and dependency boundary

Produce `on-runner` for Linux amd64 and arm64, with `CGO_ENABLED=0` for the preferred pure-Go runtime options. The worker requires neither Node, npm, a JS database module, nor SQLite.

Commands:

```text
on-runner start-workers
on-runner version
on-runner doctor
on-runner validate-expression --runtime <profile>
on-runner internal-eval-worker
```

The last command is private, launched by the supervisor with bounded IPC. `doctor` checks coordinator connectivity and execution prerequisites without claiming a job.

“Single binary” describes the runner distribution. `run:` still requires the configured shell and workflow tools; Docker steps need a Docker CLI/daemon, and systemd execution needs systemd tooling and service access. A Go rewrite cannot embed every job's build toolchain.

Suggested layout:

```text
runner/
  cmd/on-runner/
  internal/config/
  internal/protocol/
  internal/credentials/
  internal/supervisor/
  internal/lease/
  internal/execution/
  internal/drivers/{process,systemd,docker}/
  internal/runtime/{compatjs,cel}/
  internal/helpers/
  internal/workspace/
  internal/logging/
  internal/integrations/
  internal/update/
  testdata/{protocol,expressions,workflows}/
```

Keep transport DTOs separate from execution types. In particular, handle numeric API job IDs separately from string IDs inside historical report structures; do not decode all JSON numbers through `float64` indiscriminately.

### 4.2 Supervisor and lease state machine

Use one supervisor to own capacity and an active-lease map. Each assignment has a cancellable Go context, renewal state, report state, execution handle, and unique workspace. Avoid global mutable shutdown state.

```text
claimed -> preparing -> executing -> finalizing -> completed
                  \         \            \
                   cancelled / fenced / failed
```

- Allocate a slot before claiming. If shutdown wins a claim race, release only if execution has not started.
- Start renewal before potentially slow secret fetch/setup. Track a conservative local lease deadline using monotonic time and server TTL; renewal `204` extends from a safe request-time estimate. Prefer a future API returning authoritative expiry.
- Serialize renewal per lease. Retry transient transport errors only within a safety margin before expiry; stop immediately on definitive authorization/fencing failure. If ownership cannot be proven by the deadline, cancel all execution and prohibit further side effects.
- Check lease/cancellation state before every step, helper with external effects, dispatch, file finalization, and completion. `eval:` must be cancellable too; today only shell handles are registered.
- Keep renewal, heartbeat, and state reconciliation active during graceful drain. After a configured grace period, terminate all job processes and evaluation subprocesses, then exit.
- Treat SSE as a wakeup, including update and cancellation notifications. Reconcile active leases on initial connection, reconnect, and periodic fallback. A buffered wake channel avoids lost notifications and polling overlap.
- Do not blindly retry claims after ambiguous responses as if no lease was created. The initial compatible policy waits for the orphaned lease to expire; a later API should support claim idempotency and listing active assignments.
- Report and log snapshots can be retried with stable content. Serialize writes so an old report cannot overwrite a later state. Completion retries reuse identical status/report bytes; server comparison is not a general durable idempotency guarantee.
- Never promise exactly-once external execution. Lease expiry can requeue work after partial side effects. Dispatch is deduplicated, but shell deployments and external plugin calls need their own idempotency.

### 4.3 Execution and process drivers

Implement a shared command specification and two isolation drivers. Docker command construction is shared rather than copied into both drivers.

- Process: `os/exec`, explicit environment, working directory, concurrent stdout/stderr drains, Linux process group, SIGTERM then SIGKILL after a grace period. `exec.CommandContext` alone does not terminate an entire process tree.
- Systemd: unique sanitized unit names including job/step/attempt plus a random suffix; `--wait`, `--pipe`, `--collect`, `Type=exec`, working directory, environment, and runtime limit. Current step driver omits `Type=exec` although the project runbook requires it; add and verify it.
- Detect usable systemd, not merely `/run/systemd/system`. An explicit configured driver should fail clearly if unavailable; automatic mode may use the process fallback.
- Docker: preserve `/workspace`, bind mounts, shell `-e`, image HOME behavior, and environment-key passing. Do not inject host PATH into the container. Track container identity in both drivers and explicitly stop it on cancellation; killing the Docker client does not guarantee the daemon-owned container stops.
- Derive success from exit status, never stderr. Preserve stdout/stderr capture and timestamp formatting. Test noisy successful commands and short-lived commands.
- Distinguish user cancellation, deadline expiry, lease fencing, and startup failure internally; map to compatible wire statuses with a meaningful error string.
- Establish workspace ownership for the job user/container UID rather than reproducing unconditional `0777` everywhere. Test the existing root-created-workspace use case and document any permissions migration.

### 4.4 Workspaces, storage, and secrets

Use `workspaces/<job-id>/<lease-id>/` with logs and working directory beneath it. Never reuse a stale lease's working directory. Maintain only a small private cleanup journal locally; the server remains authoritative.

Implement one workspace filesystem boundary used by expression helpers, secret-file writes, cache restore, and artifact collection. Lexical path-prefix checks alone do not prevent symlink traversal. Prefer root-relative, traversal-resistant APIs on the pinned Go toolchain; explicitly handle symlinks, hard links, special files, and rename races. Secret file creation must not follow a pre-existing symlink.

Preserve the current basic glob semantics in compatibility mode (`*` excludes `/`, `**` crosses it); do not silently substitute a library whose `**/` matching differs. Bound traversal count, file count, per-file bytes, aggregate bytes, and decoded base64 size.

Write secret files with `0600`, prevent their accidental inclusion in artifacts/caches, and remove job secrets/workspaces under a defined retention policy after upload. Raw secret values stay available in memory for execution, but redact logs/reports before upload as well as in the UI. Existing `SecretStore.redactText` is not called by the worker upload path; server-side display redaction is not protection for persisted raw reports.

Initial Go transport must respect current API limits and return actionable size errors. A later additive protocol can offer sequenced logs and chunked/object-store artifact transfer. Do not simulate append-only chunks against the current replacement-log endpoint.

### 4.5 Configuration and lifecycle integrations

Keep existing worker environment names where meaningful. Add declarative JSON or YAML configuration with a documented precedence rule; reject executable `runner.config.mjs` with a migration message. Preserve environment declaration order in the normalized execution representation: Go maps have no stable iteration order, and existing workflow environments can reference earlier entries.

For v1 compatibility, use an ordered decoder for environment JSON objects, matching JS property enumeration (integer-like keys first, then insertion order), or have the coordinator emit an ordered-entry extension. A plain `map[string]string` port will break valid configurations.

Port `github-status` as a built-in Go integration with explicit credential mapping and HTTP deadlines. Inventory user-supplied JS plugin factories and direct `config.plugins` objects; arbitrary JS callbacks cannot run inside a no-Node Go runner automatically. Offer compiled-in integrations or coordinator-owned webhooks, and fail unsupported plugin configuration clearly. Do not turn the expression runtime into a hidden plugin/module loader.

### 4.6 Binary releases and updates

Initially ship externally managed pinned binaries and omit `updater` capability. To reach existing opt-in update parity, implement a `systemd-binary` adapter:

1. Resolve an exact version through an allowlisted release manifest for the runner's OS/architecture.
2. Download to a private staging directory; verify signed manifest/digest and executable metadata.
3. Drain and confirm there are no active leases; atomically switch to the staged executable while retaining the previous release.
4. Use an external supervised restart/watchdog path. The same executable can provide this helper mode; it must survive the worker service's cgroup restart.
5. Confirm startup and a matching version heartbeat. Restore the previous release through the documented updater mechanism if verification fails.

Current coordinator update requests have no artifact digest or platform metadata and mark success on version alone. Extend the contract for stronger verification before advertising that guarantee. Existing global one-update-at-a-time serialization and idle-runner gating can remain. Test interrupted download, wrong architecture, bad digest, restart failure, and failure before first heartbeat.

## 5. JavaScript option: minimal namespace, real compatibility

### 5.1 What the present evaluator actually is

`src/safe-eval.ts` parses one expression with Acorn ES2020 and interprets selected AST nodes. It does not invoke Node `eval`, `vm`, or `Function`.

Supported forms are literals, identifiers, member access, calls, selected arithmetic/comparison/logical/unary operators, template literals, arrays, object literals, optional-chain wrappers, and ternaries. Statements, declarations, arrow functions, assignment, loops, `new`, imports, and `await` are not supported by the walker.

The four built-in names already match the requested list: `String`, `Number`, `Boolean`, and `JSON`. Job data and `files` are separately injected context names. GitHub trigger evaluation additionally injects `github.fileExists`, an asynchronous coordinator helper. There is no shipped general-purpose helper such as `slack_notify`; that appears only as an illustrative comment.

The exposed behavior is larger than those four names suggest: method calls resolve actual JavaScript methods from values, including inherited string/array/object methods. A small global dictionary is not the same as a small callable surface.

### 5.2 Compatibility quirks to capture explicitly

| Area              | Current implementation                                                                         | Migration decision                                                                |
| ----------------- | ---------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------- | -------------------------------------------- | ----------------------------------------- |
| Equality          | `===` and `==` both use JS loose equality; likewise `!==` and `!=`                             | Preserve in compatibility profile; correct in a new profile                       |
| Missing values    | Unknown identifiers and member access on null/undefined return undefined                       | Model an internal undefined sentinel; define serialization separately             |
| String helper     | `String(null)` and `String(undefined)` return empty string                                     | Wrapper required; native JS String differs                                        |
| JSON helper       | `JSON.stringify` always uses two-space indentation; extra arguments ignored                    | Wrapper required                                                                  |
| Templates         | Null/undefined interpolate as empty string                                                     | Native JS template coercion differs                                               |
| Logical operators | `&&`/`                                                                                         |                                                                                   | `return operands;`??` is parsed but rejected | Do not replace with Go boolean operations |
| Arithmetic        | Only `+ - * /` and listed comparisons; no `%`, exponentiation or bitwise operators             | Validate exact operator set                                                       |
| Parsing           | `parseExpressionAt` does not verify complete source consumption                                | Reject trailing source as an explicit validation fix                              |
| Objects           | Spread properties are ignored; computed identifier keys are mishandled                         | Flag and migrate these cases rather than advertise complete JS support            |
| Optional access   | Ordinary missing-member access is also null-tolerant; optional calls are not fully implemented | Test member and call cases separately                                             |
| Mutation          | Native methods such as array mutation can alter shared context                                 | Inventory use; new profiles should expose read-only data                          |
| Literals          | Acorn can create regex/BigInt values, which are not ordinary JSON outputs                      | Define supported literal subset and output rejection policy                       |
| Evaluation order  | Arguments and template substitutions use `Promise.all`                                         | Avoid assuming strict JS left-to-right helper effects; make new helpers read-only |

The existing prototype-name blocklist is not a complete security model: identifier lookup uses inherited properties, property guards precede JS key coercion, and object construction writes into ordinary objects. Reimplement the boundary with owned data and explicit callable capabilities, not the existing blocklist alone.

### 5.3 Preferred compatibility implementation

Use a maintained Go JavaScript parser, with Goja's parser as the first candidate, and implement a small evaluator over a validated AST. A short spike must confirm template literals, optional chains, object-expression parsing, regex handling, source spans, and full-input validation on the pinned dependency. Do not assume “ES2020” from the old parser means every candidate implements identical syntax.

Evaluator work:

1. Define runtime values: null, undefined, bool, IEEE-754 number, string, ordered object, array, and opaque helper reference. Functions/host pointers are not ordinary context data.
2. Implement the exact accepted node/operator set and JS-compatible conversions used by actual workflows. Include number/string addition, truthiness, loose equality, string indexing/length in UTF-16 terms, negative zero, NaN/Infinity handling, and JSON omission/null behavior.
3. Implement an explicit method table, initially driven by the workflow inventory: likely string `replace`, `split`, `slice`, `includes`, prefix/suffix checks and case conversion; array indexing/length/join/includes as needed. Regex replacement is a separate compatibility task, not a Go `strings.Replace` substitution.
4. Register only the four built-ins plus versioned helper capabilities. Keep context roots separate from helper lookup and disallow context keys from replacing built-ins.
5. Resolve data properties as own properties only. Normalize computed keys before validation. Treat sensitive property names as data only where safe, never as host/prototype access.
6. Use read-only context snapshots. If deployed workflows depend on mutation, either implement it in an isolated legacy value graph or reject it with a targeted migration diagnostic; never mutate the supervisor's Go maps.
7. Apply parse/evaluation/result/helper budgets, with cancellation checkpoints. Every helper receives the job context/deadline. Bound file reads and JSON parsing/stringification before large allocation.
8. Cache validated immutable ASTs by profile, helper ABI, source hash, and relevant schema version. Do not cache secrets or live contexts.

This implements a **runner expression dialect with JavaScript syntax**. It should not be marketed as a standards-complete JS runtime. The benefit is that the visible global environment and callable surface can truly be allowlisted.

### 5.4 Alternative: execute inside Goja

Goja is pure Go and provides real JavaScript execution, explicit host bindings, and interruption. It is attractive if standard JS behavior is preferable to exact legacy behavior, or if the existing method surface is too broad to maintain manually.

However:

- A new runtime includes ECMAScript globals and intrinsic prototypes. Removing global `Function`, `eval`, `Object`, or `Array` names does not remove constructor/prototype reachability through literals or bound functions.
- To retain an expression-only product, validate every accepted AST node and property/call target before execution, and handle dynamic keys. Global cleanup is defense in depth, not the primary boundary.
- Do not expose reflected Go services, structs with exported methods, `os`, `exec`, networking clients, or a Node compatibility layer. Create explicit data copies and narrow host wrappers.
- One Goja runtime belongs to one goroutine at a time. Prefer a fresh runtime per evaluation/job isolation unit; sharing a runtime across concurrent jobs is invalid.
- `Runtime.Interrupt` can interrupt JS execution, but it does not make a blocking host helper cancellable or impose a hard per-runtime heap limit. Helpers need their own deadlines/quotas, and hard memory limits require process isolation.
- Standard execution changes strict equality, null access, template conversion, and object behavior. A few wrapper functions cannot repair all of these differences. AST rewriting would itself become a language implementation.

If this route is chosen, introduce `js-expr-v2` with documented standard semantics and an expression allowlist, rather than silently replacing the old evaluator. It is the better JS option when language consistency is more valuable than preserving implementation quirks.

### 5.5 Other JavaScript engines

- **QuickJS with CGo:** good standards coverage, runtime memory limits, stack limits, and interrupt hooks. A statically linked single executable is possible, but it is no longer a pure-Go cross-build: C toolchains, bindings, reference-counted value ownership, platform artifacts, and engine updates become release responsibilities. Never expose its `std`/`os` modules. Engine memory quotas do not cover host helper allocations.
- **QuickJS compiled to WASM inside a Go WASM engine:** can preserve a pure-Go host and bundle the guest bytes, with a clearer linear-memory boundary. It adds a guest build chain, marshaling, helper imports, and timeout validation. This is a worthwhile isolated spike only if memory containment is decisive; it is not the lowest-effort migration.
- **V8 bindings:** excessive native packaging/toolchain weight for the existing expression-only use case.
- **Node as an external executable:** useful as a temporary comparison oracle, but fails the no-Node runner goal.

### 5.6 Isolation and resource limits

The current `Promise.race` timeout does not stop synchronous work or revoke helper execution. Replace it with cancellation that actually terminates evaluation.

Proposed starting policy, to tune with measurements: 64 KiB expression source, bounded AST depth/node count, bounded collection iterations, 1 MiB helper read/result limits, a short pure-expression deadline, and the step deadline for file/helper operations. These are proposed new limits, not existing guarantees; inventory workflows before enforcement.

For hard containment, launch `on-runner internal-eval-worker` in a separate cgroup with CPU/memory limits. Communicate through private bounded pipes, with typed request/result envelopes and allowlisted helper RPC. The child gets no runner credential or ambient host environment. Parent-side helper RPC must obey the same deadline and cancellation, so killing the child also prevents late helper completion from causing further effects.

A Go soft memory limit is process-wide and is not a sandbox quota. On hosts without a supported hard-isolation mechanism, report the weaker mode explicitly or require a compatible container/cgroup configuration for workflows that demand hard limits.

## 6. Alternative: a language-neutral expression service

### 6.1 What “generic runtime” should mean

There is no useful syntax-free runtime for source expressions. Authors still need a language with defined operators, missing-value behavior, conversions, collections, and function calls.

Make the **runner's contract** generic, not the semantics vague:

```text
Compile(profile, source, contextSchema, helperABI) -> immutable program + diagnostics
Evaluate(program, JSON context, capabilities, limits, cancellation) -> JSON value | typed error
```

The runner orchestrator must not know whether a program uses JS, CEL, or Expr. The selected profile and its version must be pinned in each workflow revision and job, with explicit supported-profile capabilities in runner heartbeats. Unknown profiles fail validation or remain unschedulable; they must never silently fall back to another language.

Start with one primary language and, only if needed, one migration adapter. A public plugin system accepting arbitrary runtimes would multiply testing, packaging, and support costs.

### 6.2 Candidate comparison

| Option                        | Fit for this runner                                                                                                                                             | Principal cost                                                                                                                   |
| ----------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------- |
| CEL                           | Best portable contract for conditions and structured expressions; specified language, type checking, list/map expressions, cost accounting in Go implementation | JS coercion/method syntax changes; JSON and workspace helper extensions; Node coordinator bridge                                 |
| Expr                          | Excellent Go-native embedded expression engine, helpful diagnostics, collection operations and static checks                                                    | Its semantics are a different language; less cross-language portability than CEL                                                 |
| Starlark                      | Best candidate if `eval:` grows into multi-statement data-transformation scripts                                                                                | More language surface; expression vs script result conventions; resource limits still needed                                     |
| Lua                           | Compact general scripting, mature embedding model                                                                                                               | More semantic migration, standard-library removal, execution/memory controls; little advantage for current expression-only jobs  |
| WASM/WASI                     | Good future extension ABI for compiled tasks/helpers from many languages                                                                                        | Not an authoring expression language; needs a frontend/compiler or embedded interpreter, ABI, imports, and artifact distribution |
| Custom neutral AST/JSON rules | Strict control over operations and serialization                                                                                                                | Own parser/authoring UX or verbose JSON; permanent language/tooling maintenance                                                  |

**Default choice if compatibility is negotiable: CEL for both `if:` and `eval:`.** Use map/list literals for normalization outputs, not imperative scripting. Prefer Expr instead if the project intentionally standardizes on Go and a short integration path outweighs portable semantics. Add Starlark only after identifying transformations that cannot reasonably be expressions or shell/container tasks.

CEL and Expr's constrained core languages do not make arbitrary host callbacks safe or cheap. A helper can block, allocate, or perform I/O regardless of the expression language. Budget helper calls and size inputs/results separately from VM evaluation cost.

### 6.3 Versioned workflow syntax

Proposed new fields, not supported by the current parser:

```yaml
id: github-intake
name: GitHub intake
expressionRuntime: cel-v1
executionSemantics: v2
on:
  scm-hook: {}
env:
  REPOSITORY: "${inputs.body.repository.full_name}"
steps:
  - id: normalize
    eval: |
      {
        "repository": inputs.body.repository.full_name,
        "event": inputs.request.headers["x-github-event"]
      }
  - id: handoff
    dispatch: build-and-test
    with: steps.normalize.outputs
```

Use one runtime per workflow initially. Keep runtime selection separate from execution semantics, so changing false-condition behavior or step-local environment does not accidentally change language syntax.

Define the portable value boundary as JSON-compatible values with string-keyed objects, arrays, null, booleans, strings and a documented number policy. CEL's integer/double distinctions must be preserved deliberately; declare safe numeric ranges or encode large identifiers as strings. Do not pretend JavaScript doubles, CEL integers, and Go `int64` are interchangeable.

For the new profile:

- `if:` requires a boolean result, rather than JS truthiness.
- `eval:` returns a JSON value; `with:` requires a JSON object.
- Unknown names are compile errors. Missing dynamic fields require presence/default logic, such as CEL `has`, rather than implicit JS undefined.
- Undefined, functions, cycles, bytes, timestamps, durations, NaN/Infinity and other non-JSON outputs require explicit conversion or produce a typed output error.
- Context values are read-only. JSON helpers and string conversions have named, documented contracts.
- Errors identify workflow/revision, YAML field, step, source span, runtime profile and error class without copying secrets into diagnostic messages.

### 6.4 Interpolation is a separate feature

Stop implementing interpolation by wrapping arbitrary text in JavaScript backticks. Tokenize literal segments and `${expression}` segments using the selected language's lexical rules, preserving source spans and handling quotes, escapes, nested braces and comments. A regular expression alone cannot correctly split all expressions.

Keep backward-compatible value behavior: strings without interpolation remain literal; mixed templates yield strings; native YAML values pass through. For CEL, document scalar-to-string conversion and require `json.stringify` for collections. Keep structured values in `eval:` and `with:` rather than introducing a surprising whole-string typed interpolation shortcut.

Only explicitly documented fields are interpolated. Preserve literal `run:` so shell `${HOME}` and shell quoting keep their meaning. Add image/name interpolation, if desired, only under the new execution semantics with dedicated tests.

### 6.5 Helpers as capabilities

Describe helpers independently of syntax:

```text
helper name + ABI version
input/output schema
execution phase: trigger | job | step
required capability
purity / external effects
deadline, byte and call-count limits
```

Initial helpers are conversions, JSON encode/decode, workspace exists/read/join, and the existing GitHub contents predicate in trigger context. Use context-specific capability sets: a trigger evaluator has no workspace; a worker should not receive the coordinator's GitHub token merely to evaluate expressions.

For CEL, prefer explicit namespaced custom functions such as `files.exists(path)` over exposing Go objects with methods. Bind them through a deliberately narrow adapter and verify the selected engine's function-overload conventions in the spike. Preserve synchronous expression results even if a Go helper performs cancellable I/O internally; there is no need for user-visible promises or `await`.

Long term, move network checks into explicit acquisition/preprocessing steps and pass their results as data. This makes conditions predictable and allows pure evaluation to be cached. It is a workflow change, not a transparent replacement of `github.fileExists`.

### 6.6 The coordinator consistency problem

Changing only the worker is insufficient. Expressions run in:

- Webhook `on.if` and concurrency grouping in `src/server.ts`.
- Matrix tags from webhook, manual run, dispatch and scheduler paths.
- Workflow/step environments, cache keys, plugin credentials, step conditions, `eval:`, and dispatch `with` on the worker.

For the legacy profile, keep the TS evaluator as an oracle until parity tests pass. For CEL or another new profile, make the Go implementation authoritative and invoke the same executable in a restricted coordinator-side evaluator mode. This can start as bounded one-shot IPC and become a supervised process pool if benchmarks justify it. The server remains Node; only expression evaluation is delegated.

Trigger helper calls should stay in the server through a narrow helper RPC or explicit precomputed data. Do not spawn an evaluator with all coordinator secrets. Validate shutdown, process failure, request IDs, backpressure, deadlines, and malformed IPC responses. A remote evaluator service is unnecessary for the first version.

An independently implemented Node CEL evaluator is an alternative only with a shared conformance corpus and identical helper/value profiles. Standardized syntax alone does not guarantee matching extension behavior.

## 7. Implementation and migration plan

### Phase 0: contract and corpus, 1–2 engineer-weeks

- Inventory active and historical workflow revisions, expressions, methods, plugins, config modules, and runtime expectations. Export only appropriately sanitized examples for fixtures.
- Separate intended behavior, accidental behavior to preserve temporarily, and explicit breaking fixes.
- Produce wire fixtures from current server responses, including typed secrets, matrix payloads, numeric IDs, cancellation, cache keys and duplicate completions.
- Align protocol/OpenAPI documentation with implemented routes and limits.
- Establish current acceptance tests and a safe lab coordinator. No production workflow executions for differential testing.

Exit: a signed-off compatibility matrix and a representative corpus, not an assumption that all JS-looking text is supported JS.

### Phase 1: runtime spikes and decision, 1–2 engineer-weeks

Build disposable prototypes for restricted JS and CEL (Expr if Go-only is preferred). Measure parser coverage, real workflow migration effort, helper calls, diagnostics, interrupt behavior, resource amplification, startup cost, memory and binary size on amd64/arm64.

Specifically compare JS methods, missing properties, equality, template escaping, object outputs and JSON round trips. Verify cancellation during a helper, not just during VM instructions. Pin candidate dependencies and record their licenses/toolchain requirements.

Exit: select a primary runtime and whether a legacy adapter is required. No unmeasured binary-size/performance claims.

### Phase 2: Go transport and supervisor, 2–3 engineer-weeks

Implement CLI/config, credential storage, enrollment, typed client, heartbeat, claims, SSE parsing/reconciliation, lease deadlines and drain. Use a fake coordinator first, then current Node server in an isolated lab environment.

Exit: bounded concurrent dummy leases, revoke/cancel/reconnect correctness, startup without database/Node dependencies, no credential leakage.

### Phase 3: execution parity, 3–4 engineer-weeks

Implement process/systemd/Docker drivers, ordered environments, job and report state machines, retries, workspace/helpers, chosen evaluator, files and built-in GitHub status integration. Feed existing TS worker fixtures and new behavioral cases into both implementations.

Exit: equivalent results for the agreed legacy corpus or approved CEL rewrites; no process/container left running after cancellation; correct final reports and uploads.

### Phase 4: coordinator/runtime migration, 1–3 engineer-weeks

Add runtime profile metadata to parsing/schema/revisions, validation and scheduling capabilities. Implement the coordinator evaluator bridge for the new language. Update help/editor/AI-authoring examples. New revisions can opt in; historical revisions retain their explicit/default legacy profile.

During mixed-fleet operation, route `cel-v1` only to capable runners. Existing code conflates labels and capabilities, so either add server-owned runtime requirements to eligibility checks or carefully use explicit required capability tags during canary. Do not let a legacy worker claim a new-runtime workflow and discover incompatibility after side effects.

Exit: identical trigger and step semantics for each runtime profile, clear unsupported-runtime diagnostics, and reversible workflow publication.

### Phase 5: release, canary, and updater, 2–3 engineer-weeks

Ship signed pinned binaries and service/container packaging. Enroll one lab Go runner with dedicated labels. Exercise complete flows, crashes, restarts, revocation, network loss and artifact failures. Add the binary updater only after normal execution is stable.

Then canary selected production workloads with authorization and a defined rollback: drain the Go runner, retain logs/reports, route legacy-compatible jobs back to Node workers. New-language revisions require capable workers or publication of an equivalent legacy revision; changing the runner alone does not roll back a language migration.

Exit: observed lab acceptance, bounded resources, mixed-fleet operation, update/rollback verification, and no need for a database credential on a runner.

### Effort summary

These are planning estimates for an engineer familiar with Go and this system, not measured implementation durations. Phases overlap in content; runtime-specific totals below avoid simply adding every range.

| Delivery                                                                        | Estimated effort                                                | Main uncertainty                                      |
| ------------------------------------------------------------------------------- | --------------------------------------------------------------- | ----------------------------------------------------- |
| API-only Go runner, restricted-JS compatibility, release/canary                 | 10–16 engineer-weeks                                            | Native method/coercion usage and lifecycle edge cases |
| Go runner with CEL, existing workflows deliberately migrated, no legacy adapter | 9–14 engineer-weeks plus corpus conversion                      | Number of workflows and coordinator integration       |
| Mixed JS/CEL transition with both evaluators                                    | 13–20 engineer-weeks plus corpus conversion                     | Dual semantics and long-tail compatibility support    |
| Production binary self-updater beyond externally managed releases               | Add roughly 1–2 engineer-weeks if not included in release phase | Packaging, restart watchdog and verification protocol |

Within those totals, a production-quality restricted-JS evaluator is approximately 3–5 engineer-weeks, not the few days needed to embed a parser. A CEL/Expr adapter is approximately 1–2 weeks for basic evaluation and another 1–2 for helpers, interpolation, quotas and diagnostics; shared corpus/conformance work is still required. General-purpose scripting and arbitrary JS plugin compatibility are additional scope.

## 8. Verification and acceptance criteria

### Runtime conformance

- Differential TS/Go tests for literals, missing/null values, coercion, equality, logical operands, string/array methods, Unicode, templates, JSON and structured outputs.
- Reject trailing code, disallowed nodes, dynamic constructor/prototype access, inherited lookup, function values and cyclic results according to profile policy.
- Test literal backticks, escaped interpolation, nested object literals, bracketed keys and malformed templates.
- Test helper paths including symlinks and traversal, oversized reads/JSON/results, cancellation and repeated calls.
- For new languages, document semantic changes and test expected new results; do not require them to reproduce JS bugs.

### Protocol and lifecycle

- Actual Node coordinator conformance, beyond mocks: enrollment/credential persistence, shared/team grants, grant revocation, expired leases, numeric IDs, encoded secrets and duplicate completion.
- Concurrent claims and per-runner ceilings; crash after claim/before step/during step/after external side effect/before completion.
- Missed SSE, split UTF-8/CRLF frames, multi-line data, unknown events, oversized frames, reconnect storm and coordinator restart.
- Network failures during renewal, logs, reports, file upload and completion; no new work after fencing.
- All step kinds cancel, including expression/helper execution and finalization; drain keeps heartbeats/renewals until work stops.
- Dispatch idempotency, same-workspace resolution, object validation and limits.

### Execution and packaging

- Linux systemd tests on a real systemd host; process fallback tests; Docker tests against a disposable daemon/target.
- Child/grandchild termination, Docker-client disconnect, large concurrent stdout/stderr, failed spawn, zero exit with stderr, timeout, retries and workspace cleanup.
- Current report/UI contract and timestamp formatting; a representative browser run view smoke test after integration.
- Build amd64/arm64 artifacts; `go test ./...`, `go test -race ./...`, `go vet ./...`, formatting and dependency vulnerability checks on implementation changes.
- Fuzz parser/value conversion, interpolation scanner, SSE parser, JSON/IPC boundaries and workspace paths.
- Verify artifact startup with Node/npm and database environment absent; distinguish runner prerequisites from job-tool prerequisites.
- Benchmark idle RSS, per-job memory, expression p50/p95, startup, log throughput and heartbeat/renewal latency at configured concurrency. Set release thresholds after baseline measurements.

The present design review does not constitute a runtime benchmark, compatibility proof, or deployment test. These gates are required during implementation.

## 9. Decisions to settle before implementation

1. Is preservation of deployed expressions required, or can workflows be republished using CEL? This determines whether a legacy evaluator is a product feature or only a migration tool.
2. Is `eval:` intentionally expression-only? The existing code and examples support keeping it so.
3. Which compatibility quirks are explicitly retired: false-condition stop, loose `===`, step-local env invisibility, partial parsing, and mutating methods?
4. Is hard per-evaluation memory containment required on every worker, including process-fallback hosts?
5. Which custom JS configuration/plugins are actually deployed, and what replacement contract do they need?
6. Should first release retain current small transfer limits or include a separately specified streaming protocol?

Recommended default: API-only Go runner, versioned runtime interface, compatibility profile during rollout, CEL for new workflows, expression-only `eval:`, and hard isolation through a subprocess of the same executable where required.

## 10. Runtime references

Upstream documentation consulted during this design review; pin and revalidate exact versions during the spike:

- [Goja](https://github.com/dop251/goja): pure Go, runtime concurrency constraints, host bindings, interrupt API, and documented Unicode/JSON caveats.
- [QuickJS manual](https://bellard.org/quickjs/quickjs.html): runtime/context model, native integration, memory/stack limits and interrupts.
- [CEL Go](https://github.com/cel-expr/cel-go), canonical import path `cel.dev/cel-go`: typed expression compilation, stateless evaluation and language semantics. The former `github.com/google/cel-go` repository now directs new integrations to the canonical path.
- [Expr](https://github.com/expr-lang/expr): Go-oriented expression evaluation and compile-time checking.
- [Starlark Go](https://github.com/google/starlark-go): expression/script embedding, cancellation/step budgets, and explicit warning that hard memory isolation requires operating-system support.

## 11. Release and distribution model

The primary motivation for a Go runner is a single, dependency-free executable per platform.

- Build with `CGO_ENABLED=0` and cross-compile one artifact per `GOOS/GOARCH` (Linux amd64/arm64, macOS, Windows as needed).
- Publish artifacts directly to GitHub Releases. No npm registry, no package manifest, no registry credentials, and no dependency on Node.js or npm at runtime.
- Operators download the matching binary, place it on a machine, and start it. Version upgrades are a binary replacement plus service restart.
- Node.js is an optional external tool only on machines where workflows use `eval:`. Runners advertise `node-eval` capability in heartbeats; only runners with that capability may claim `eval:` jobs.
- Systemd unit files and container image definitions are separate, versioned alongside the binary but not embedded in it.

## 12. Plugins and preprocessors move to workflows

Keep the runner core lean and generic. The binary must not contain:

- A JS plugin registry (`registerWorkflowPlugin`, `PluginManager`).
- A webhook preprocessor registry (`GitHubPreprocessor`).
- OIDC, user, team, or secret management.

Plugins become explicit workflow steps:

- GitHub commit statuses are emitted by a `run:` step calling `curl`/`gh`, or a dedicated lightweight step. Secret mapping remains explicit in the workflow definition.
- Webhook signature validation stays on the coordinator. Normalization, filtering, and field extraction move into workflow expressions or dedicated intake steps.
- The runner's responsibility is limited to claiming leases, executing steps, reporting results, and uploading logs/artifacts.

The coordinator remains the only process with database access. The runner remains API-only and starts without `DATABASE_URL`.

## 13. Revised recommendation

Given the single-binary and lean-core goals:

1. Build an API-only Go runner using the existing authenticated runner lease protocol.
2. Implement a minimal Go expression interpreter for conditions and `${...}` interpolation, supporting only a fixed set of globals: `String`, `Number`, `Boolean`, `JSON`, and explicit runner helpers.
3. Drop embedded `eval:` from the core evaluator. Offer `eval:` as an optional Node.js subprocess step, gated by runner capability.
4. Move GitHub status and webhook normalization out of the runner and into workflow steps or coordinator-side preprocessors.
5. Release cross-platform binaries through GitHub Releases.
