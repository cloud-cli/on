# Flow — UI concept

A lightweight, interactive design prototype for Flow's CI dashboard. Built with plain HTML, CSS, and JavaScript, with no build step or runtime dependencies. DM Sans and IBM Plex Mono load from Google Fonts, with local fallbacks.

## Preview

From the repository root:

```sh
python3 -m http.server 4173 --directory docs/ui-concept
```

Open `http://localhost:4173`. You can also open `index.html` directly.

Export a portable HTML file with styles and behavior embedded:

```sh
node docs/ui-concept/export.mjs /tmp/opencode/flow-concept.html
```

## Design

- Warm white canvas, quiet sage navigation, restrained status colors, and a dark log reader.
- Runs first: search, combined status/workflow/branch filters, pagination, and URL-preserved filter state.
- Open a failed run to land on its failed step. Search logs, jump to the error, wrap lines, copy a step, or download the full run log.
- Run details include trigger inputs, illustrative workflow source, artifacts, and linked execution history.
- Dispatch, rerun, and cancellation controls work against in-memory sample runs. Reruns retain their parent and increment the displayed attempt number.
- Supporting workflow, worker-capacity, and settings screens keep configuration out of the main job list.
- Mobile bottom navigation, keyboard-operable controls, native dialogs, reduced-motion support, and persistent density/wrapping preferences.

Keyboard shortcuts: `/` searches runs, `N` opens dispatch, `?` shows shortcuts, and `Esc` closes dialogs.

## Data and integration boundary

This is a design artifact, not a production API client. All displayed runs, logs, worker metrics, identities, artifacts, and secret names are illustrative. Reloading resets sample run changes. Only display preferences persist locally. Sample queued/running jobs do not advance automatically.

The reference was the live Flow dashboard and its run templates, alongside the published OpenAPI specification at `https://flow.api.apphor.de/api`. The concept preserves workflow IDs, run IDs, statuses, workers, execution steps, logs, trigger inputs, revision context, artifacts, and restart history.

Production integration should map the run list to `GET /api/jobs`, details to `GET /api/runs/{jobId}`, dispatch to `POST /api/workflows/{workflowId}/run`, reruns to `POST /restart/{jobId}`, cancellation to `POST /api/jobs/{jobId}/cancel`, and updates to `GET /api/events`. Logs and artifacts must respect the existing authorization model. Commit/branch summaries and worker-capacity cards need verified backing data; they are not assumed to exist in the current job-list API.

## Source checks

```sh
pnpm exec eslint --config docs/ui-concept/eslint.config.js docs/ui-concept/app.js docs/ui-concept/export.mjs docs/ui-concept/eslint.config.js
```

Format these files with Prettier using a 120-column print width. The scoped ESLint configuration applies recommended JavaScript checks and mandatory branch braces to the prototype.
