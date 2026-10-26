# V3 implementation plan

This plan translates `v3.md` from the `v3` branch into incremental, verifiable delivery. The proposal explicitly labels its YAML, resource paths, and interfaces as illustrative; finalize contracts before committing to implementation details. Keep each slice independently deployable and preserve current workflow and recipe compatibility.

## Baseline and progress accounting

At the time this plan was created, `main` and the tip of `v3` have the same application tree; the only net addition on `v3` is the design proposal. The current application has useful foundations, including workspaces, versioned workflow/recipe data, downstream dispatch, run inspection, and SSE notifications, but these are not by themselves completion of the v3 requirements. Existing `pnpm test:e2e` is a Docker smoke test with mocked database behavior and disabled OIDC; it does not verify real browser sign-in or v3 journeys.

**Initial implementation progress: 0%.** This is a baseline, not a claim that the existing platform has no reusable code. Documentation and planning do not count as implementation. Measure progress using these fixed milestone weights:

| Milestone                                                      | Weight |
| -------------------------------------------------------------- | -----: |
| 1. Contracts, compatibility, and migrations                    |    10% |
| 2. Durable event model and common invocation admission         |    20% |
| 3. Callable recipe functions and workflow contracts            |    15% |
| 4. Durable stream history and live workspace experience        |    15% |
| 5. Step attempts, checkpoints, replay, and reliable follow-ups |    20% |
| 6. Connectors, agents, integrations, and end-to-end acceptance |    20% |

For each milestone, award its weight only after all acceptance criteria are implemented, reviewed, and verified by relevant automated tests. Partial progress may be reported within a milestone as a separately evidenced fraction, but unverified or merely planned work scores zero. The overall percentage is the sum of earned milestone weight (including evidenced partial fractions), rounded to the nearest whole percent. Keep an evidence note per milestone: implementation paths, tests run/results, and unresolved gaps. At each v3 turn, recompute against the current diff and evidence; if below 100%, select the next unblocked tasks and delegate independent tasks to multiple agents where useful. Never inflate progress based on parallel work started or agent reports.

## Milestones and acceptance criteria

### 1. Contracts, compatibility, and migrations — 10%

**Scope:** Resolve the decisions in §15 of `v3.md`: event and schema versioning, consumer cursor/start semantics, function identities and aliases, revision pinning, checkpoint persistence/retention, and retry semantics for side effects. Inventory current schemas, API contracts, database migrations, authorization rules, and historical run behavior.

**Acceptance:** Reviewed versioned contracts and migration/rollback strategy exist; existing workflows, recipes, queued work, and historical runs remain interpretable; invocations pin the definitions they use; security boundaries for workspace-owned events, secrets, and agent tools are explicit. Add compatibility tests before dependent schema changes.

**Dependencies:** None. This is the prerequisite for the data model and execution semantics below.

### 2. Durable events and common invocation admission — 20%

**Scope:** Implement immutable typed events, publication/delivery state, consumer subscriptions/cursors, deduplication, provenance/causation, normalized reactions, addressed workflow requests, and durable completion events. Route external and internal requests through authorization, validation, filtering, revision pinning, and admission consistently.

**Likely code areas:** `src/server.ts`, `src/events.ts`, `src/queue.ts`, `src/types.ts`, database migrations/repositories, and API/OpenAPI contracts. Inspect `docs/feature-requests.md` and current event implementations before choosing exact paths.

**Acceptance:** Events survive process restart; consumers recover independently and can inspect accepted, rejected, filtered, duplicate, unmatched, and failed-delivery outcomes; delivery is idempotent; accepting an event/request is observably distinct from execution completion; authorization and workspace isolation are tested.

**Dependencies:** Milestone 1.

### 3. Callable recipe functions and workflow contracts — 15%

**Scope:** Evolve reusable recipes into versioned modules exporting named functions with input/output contracts. Support nested calls with stable call-site identities and workflow input/output contracts. Pin exact recipe/function revisions per execution and route API/tool requests through common admission.

**Likely code areas:** `src/types.ts`, recipe/workflow schemas and repositories/API, `src/worker.ts`, and existing recipe specs such as `src/workflow-recipes.spec.ts` and `src/recipes.spec.ts`.

**Acceptance:** Functions are reusable without copying their implementation; nested calls are independently inspectable; invalid inputs/outputs fail explicitly; aliases cannot silently change a pinned run; old recipe/workflow forms have tested compatibility or a documented migration.

**Dependencies:** Milestones 1 and 2.

### 4. Durable stream history and live workspace experience — 15%

**Scope:** Persist workspace Streams, Threads, bindings, and paginated event/run history; provide resumable cursors, live execution cards, causal links, and the combined Automations/workspace experience from §9 of `v3.md`. Keep Stream, Thread, event, invocation, and run as distinct concepts; see [`v3-product-model.md`](./v3-product-model.md).

**Likely UI areas:** `ui/app-shell.html`, `ui/app-router.mjs`, `ui/run.html`, `ui/run.mjs`, and related server APIs/styles.

**Acceptance:** Reconnect resumes from a cursor without gaps, duplicate presentation, or rerunning work; Streams link Threads, events, invocations, runs, and causes; current status agrees with run detail; authorization is enforced; Playwright covers relevant desktop/mobile paths without console/runtime or unexpected network errors.

**Dependencies:** Durable event and run history from milestones 2 and 3.

### 5. Step attempts, checkpoints, replay, and reliable follow-ups — 20%

**Scope:** Record immutable step attempts, inputs/outputs, logs, and pre/post sandbox references. Separate inspection, replay, resume, changed-input rerun, and event redelivery. Make downstream delivery retry independently from computation; define checkpoint storage adapters and retention.

**Likely code areas:** `src/worker.ts`, `src/queue.ts`, `src/types.ts`, `src/ai-help.ts`, run APIs, and `ui/run.html`/`ui/run.mjs`.

**Acceptance:** Failure evidence is retained; replay creates an isolated execution with original pinned inputs/definitions where available; missing snapshots or secrets are explicit; checkpoint/storage failure cannot accidentally repeat a completed external side effect; retry and cancellation are tested under interruption and restart.

**Dependencies:** Milestones 1–3 and durable execution history.

### 6. Connectors, agents, integrations, and end-to-end acceptance — 20%

**Scope:** Implement normalized provider connectors (begin with one end-to-end source), agent subscriptions and explicitly authorized workflow tools, durable correlated results, and remaining integration breadth. Validate the Stream-first workspace journeys and the v3 acceptance criteria in §14.

**Likely code areas:** `src/server.ts`, `src/preprocessors/`, `src/ai-help.ts`, connector/event APIs, and Stream/Thread UI paths.

**Acceptance:** Provider-specific verification/normalization stays in connectors; a workflow can consume equivalent normalized events across sources; immutable commit/mirror selection is verified; agent requests are scoped, auditable, resumable, and correlated with outcomes; authorization, duplicate/replay, failure, and recovery paths have tests. Browser E2E exercises implemented user journeys, checks console/network errors, and saves reviewed screenshots at relevant viewport sizes.

**Dependencies:** Durable events/admission, workflow contracts, Stream/Thread history, and reliable execution primitives.

## Delivery order and cross-cutting gates

Follow the dependency order above. The proposal's four delivery slices (§13) can be mapped to milestones as follows: slice 1 establishes milestones 1–3; slice 2 completes milestone 4; slice 3 completes milestone 5; slice 4 completes milestone 6 and remaining integration depth. Teams may build independent preparatory work in parallel, but do not expose a user-facing slice until its dependency contracts are stable.

For every change: run formatting, ESLint, relevant unit/integration tests, build/type checks, and the full relevant test suite. Review migrations, authorization, idempotency, data retention, and compatibility. Run `pnpm test:e2e` for the current Docker smoke baseline where applicable, but do not describe it as browser or production-auth coverage.

### Production OIDC and screenshots

Production authentication is a separate acceptance activity, not a substitute for local tests. Only exercise a production OIDC flow after the corresponding app flow exists and a narrowly scoped temporary client can be created and cleaned up. Follow the global OIDC runbook: read the live Auth API and discovery documents, use `AGENT_ID` and `AGENT_SECRET` only through the documented Agent sign-in flow, set exact redirect URIs, retain secrets only in process memory/protected temporary state, and delete the temporary client in a `finally` path. Verify callback/state/PKCE, protected access, refresh/expiry, logout, and unauthorized/error behavior with Playwright. Never use production data or mutate production workflows. Capture screenshots as test artifacts only after removing secrets and private data, inspect them along with console/network logs, and report cleanup or environment blockers instead of claiming success.

## Current repository test inventory

- `pnpm test` runs Vitest specs; authentication, authorization, recipes, and UI have targeted specs.
- `pnpm test:e2e` builds a Docker image and runs `tests/docker-smoke.mjs`; the current smoke checks static resources and fail-closed behavior with OIDC disabled.
- `pnpm test:worker-artifact` checks the built worker artifact.
- No production Agent-login Playwright flow or v3 journey screenshot suite is present in the baseline. Add a dedicated browser suite as part of the relevant milestone; do not use live production credentials for the existing mocked smoke test.
