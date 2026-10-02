# Flow — UI concept

A lightweight, interactive design prototype for Flow's CI dashboard. Built with plain HTML, CSS, and JavaScript, with no build step or runtime dependencies. DM Sans and IBM Plex Mono load from Google Fonts, with local fallbacks.

## Preview

The Flow application serves this concept at **`/preview`**. Once deployed, open `https://flow.api.apphor.de/preview` after signing in. Production mode reads live runs, run details, workflows, workers, and secret names from the Flow API. Dispatch, rerun, and cancellation perform real actions only after confirmation. API permissions can limit which sections are visible. Use `?demo=1` for sample data.

For standalone development from the repository root:

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
- Runs first: search, status/workflow/worker filters, pagination, and URL-preserved filter state (the sample mode also offers branch filters).
- Open a failed run to land on its failed step. Search logs, jump to the error, wrap lines, copy a step, or download the full run log.
- Run details include trigger inputs, illustrative workflow source, artifacts, and linked execution history.
- Live dispatch, rerun, and cancellation actions call Flow after confirmation; localhost/file mode retains sample-only interactions.
- Workflow definitions, worker presence, and secret names come from their Flow APIs; secret values are never requested.
- Mobile bottom navigation, keyboard-operable controls, native dialogs, reduced-motion support, and persistent density/wrapping preferences.

Keyboard shortcuts: `/` searches runs, `N` opens dispatch, `?` shows shortcuts, and `Esc` closes dialogs.

## Data and integration boundary

Localhost and file-based standalone previews use sample data. Reloading resets demo changes. Only display preferences persist locally. In production, preview reads and writes use the authenticated same-origin API; secret values are never requested or rendered.

The reference was the live Flow dashboard and its run templates, alongside the published OpenAPI specification at `https://flow.api.apphor.de/api`. The concept preserves workflow IDs, run IDs, statuses, workers, execution steps, logs, trigger inputs, revision context, artifacts, and restart history.

The preview maps runs to `GET /api/jobs`, details/logs/artifacts to `GET /api/runs/{jobId}`, workflows to `GET /api/workflows`, workers to `GET /api/workers`, and secret names to `GET /api/secrets`. It uses `GET /api/events` to refresh activity. Confirmed actions call `POST /api/workflows/{workflowId}/run`, `POST /restart/{jobId}`, `POST /api/jobs/{jobId}/cancel`, and artifact downloads use `/api/runs/{jobId}/artifacts/{path}`. Branch and commit are shown only when available in run inputs; the list API does not provide them.

## Source checks

```sh
pnpm exec eslint --config docs/ui-concept/eslint.config.js docs/ui-concept/app.js docs/ui-concept/preview-live.mjs docs/ui-concept/export.mjs docs/ui-concept/eslint.config.js
```

Format these files with Prettier using a 120-column print width. The scoped ESLint configuration applies recommended JavaScript checks and mandatory branch braces to the prototype.
