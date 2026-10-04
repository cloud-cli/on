# UI migration map

This document records the current UI surfaces, their backend contracts, and the remaining work to migrate the application to the new interface. It is a handoff/reference for future implementation, not a claim that the migration is complete.

## Direction

The target is to move **all human-facing application screens** to the new interface. Keep the existing API and data model unless a gap requires a change. Continue requiring a signed-in OIDC session. Until the new interface has feature parity, retain the existing routes as a fallback; switch the default `/` route only as an explicit cutover step.

## Current architecture

There are two UI surfaces:

1. **Existing application** — a `li3/web` component shell and router. The server serves the shell and then loads page components from `/pages/*.html`.
   - Shell: `src/app-shell.html`
   - Router: `src/app-router.html`, `src/app-router.mjs`
   - Shared header: `src/app-header.html`, `src/app-header.mjs`
2. **New interface** — the design in `docs/ui-concept/`, served as a standalone page at `/preview`.
   - Entry and embedded assets: `src/ui-concept.ts`
   - Live implementation: `docs/ui-concept/preview-live.mjs`
   - Demo implementation: `docs/ui-concept/app.js`
   - Layout/styles: `docs/ui-concept/index.html`, `docs/ui-concept/style.css`
   - `/preview-live.mjs` is served by `src/server.ts`; `/preview` requires OIDC sign-in.

The shared header has a **Preview** link. It uses `target="_top"` so the existing SPA router does not mistake `/preview` for one of its own routes.

## Existing application routes

| Route                                                | Existing screen               | Source / data                                                                                                      |
| ---------------------------------------------------- | ----------------------------- | ------------------------------------------------------------------------------------------------------------------ |
| `/`, `/runs`                                         | Runs dashboard                | `src/dashboard.html`, `src/dashboard.mjs`; `/api/jobs`, `/api/events`, push subscription APIs                      |
| `/runs/:numericId`                                   | Run details                   | `src/run.html`, `src/run.mjs`; `/api/runs/:id`, events, artifacts, cancellation, restart, AI help                  |
| `/help`                                              | Workflow syntax documentation | `src/help.ts`; also embedded by `/help?embed=1` in the workflow editor                                             |
| `/settings/workflows`                                | Workflow list                 | `src/workflows-ui.html`, `src/workflows-ui.mjs`; `/api/workflows`                                                  |
| `/settings/workflows/new`, `/settings/workflows/:id` | Workflow editor               | Same workflow component; validates, saves drafts, publishes, runs, shows revisions, and can request AI suggestions |
| `/settings/secrets`                                  | Secret management             | Same workflow component; lists names and adds/deletes write-only secrets                                           |
| `/settings/tokens`                                   | API token management          | `src/settings-ui.html`, `src/settings-ui.mjs`; `/api/api-keys`                                                     |
| `/settings/notifications`                            | Notification preferences      | `src/settings-ui.html`, `src/settings-ui.mjs`; browser notification and push APIs                                  |
| `/settings/workers`                                  | Worker settings/status        | `src/settings-ui.html`, `src/settings-ui.mjs`; `/api/workers`                                                      |
| `/workflows`, `/workflows/:id`                       | Legacy aliases                | Redirect or route to the corresponding workflow list/editor                                                        |

The route map lives in `src/app-router.mjs`; server-side document routes and page fragments are handled in `src/server.ts`.

## New interface coverage

The live `/preview` interface has hash routes `#/runs`, `#/runs/:id`, `#/workflows`, `#/workers`, and `#/settings`.

| Capability                                                  | Current preview status                                                                                          |
| ----------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------- |
| Live run list, status/workflow/worker filtering, pagination | Implemented with `GET /api/jobs`                                                                                |
| Run details, step logs, inputs, artifacts, parent history   | Implemented with `GET /api/runs/:id`; logs honor `canViewLogs`                                                  |
| Dispatch, rerun, cancel                                     | Implemented with confirmation prompts and existing APIs                                                         |
| Workflow list/source and editor navigation                  | List/source shown; **editing still opens the existing editor** at `/settings/workflows/:id`                     |
| Workers                                                     | Live presence/tags/concurrency shown; requires `workers:read`                                                   |
| Secrets                                                     | **Names only**; values are neither fetched nor displayed. Add/delete UI remains in the existing settings screen |
| Preferences                                                 | Compact layout and log wrapping are local-device preferences                                                    |
| API tokens, notifications, workflow syntax/help             | Not yet migrated into the preview                                                                               |

`?demo=1`, localhost, and file-based preview use clearly labeled sample data. Production preview mode uses live APIs and does not fall back to sample data on errors or missing scopes.

## API and data constraints

- `GET /api/jobs` returns `id`, `workflowId`, `status`, `workerId`, `createdAt`, `updatedAt`, and `hasMore`. The list does **not** provide branch, commit, message, or duration. Do not fabricate those fields; run inputs/details may provide some of them.
- `GET /api/runs/{jobId}` provides run metadata, inputs, steps/log content, artifacts, history linkage, and `canViewLogs`. The server redacts sensitive values; the UI must respect `canViewLogs` and never render secret values.
- `GET /api/workflows` returns workflow metadata/source; `GET /api/workers` returns worker presence and labels; `GET /api/secrets` returns names only.
- Live events are `jobs.available` and `jobs.changed` on `GET /api/events`.
- The preview's current writes are `POST /api/workflows/{workflowId}/run`, `POST /restart/{jobId}`, and `POST /api/jobs/{jobId}/cancel`. Keep confirmation on destructive/state-changing controls.
- Artifact download is `GET /api/runs/{jobId}/artifacts/{path}` and is independently permissioned.

## Authentication state

Browser documents are protected by the OIDC session check in `src/server.ts` / `src/safe-return-url.ts`. The workflow and secret settings APIs are temporarily configured to accept **any valid OIDC session cookie** (no admin role or API-token scopes) so signed-in users can repair workflows and add secrets. The `requireAuthenticatedUser` helper enforces this; the legacy workflow client uses same-origin cookie credentials rather than the API-token client. This temporary policy is intentionally limited to workflow/secret management; run-control, logs, artifacts, workers, and other APIs retain their existing scope checks.

`openapi.json` documents the temporary workflow/secret API policy with the `oidcSessionCookie` scheme. Revisit this exception before restoring least-privilege token scopes.

## Migration checklist

- [ ] Migrate workflow editing, revision navigation, validate/save/publish/run/delete, and AI help into the new interface.
- [ ] Migrate write-only secret add/delete controls; continue to show names only and never request/render values.
- [ ] Migrate API token, notification/push, and any required worker settings controls.
- [ ] Port the workflow syntax/help experience and remaining run-detail actions.
- [ ] Verify every page at desktop/mobile sizes, permission-denied states, keyboard access, and runtime/network errors.
- [ ] Once parity and authentication are verified, route the default app entry to the new interface and decide how long the legacy URLs remain as compatibility redirects.
