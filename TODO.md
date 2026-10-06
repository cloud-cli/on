# `/preview` UI follow-up

Each item is a separate change: run focused tests, inspect desktop/mobile screenshots, then commit and push before proceeding.

## Tasks

- [x] Add a `/preview`-aware Tailwind v4 build/source/theme pipeline while retaining existing styling so the preview remains visually unchanged.
- [x] Migrate the `/preview` shell/sidebar/topbar styles from custom CSS to Tailwind utilities and remove the corresponding CSS rules.
- [x] Migrate Runs list/detail/step-viewer styles from custom CSS to Tailwind utilities; preserve the concept step log viewer and status navigation.
- [ ] Migrate Workflows and Settings/Workers/Secrets styles from custom CSS to Tailwind utilities; remove the custom stylesheet when all app pages are migrated.
- [ ] Runs: remove breadcrumbs/page-title/user/shortcut chrome; keep run list and status navigation; forward API filter qualifiers such as `repo:octocat` and `owner:cloud-cli`; remove only “Older Flow runs are available.”
- [ ] Workflows: remove breadcrumb/page-title/user/button chrome; rows with icon-only accessible actions; display `vX`; remove redundant leading icon; add spacing between tabs and list.
- [ ] Settings: move Workers under Settings and show the workers list; truncate secret names and align list columns; remove workflow editor from Settings; keep secrets, tokens, timezone, and admin roster there.
- [ ] Sidebar profile: use the signed-in name/email/role, style role as a small badge, and link to `OIDC_PROVIDER/me` in a new tab with an external-link arrow.

## Delivery checks

- [ ] For each task: focused tests, Prettier, ESLint autofix + validation, screenshot review at desktop and mobile, semantic commit, push, inspect CI, update this checklist.
- [ ] Final full test suite and build; final diff review; confirm all tasks and report any unavailable browser/deployment verification.
