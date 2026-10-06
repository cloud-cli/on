# Flow `/preview` UI follow-up

## Scoped work
- [ ] Map existing app styles to Tailwind v4 theme/config and replace custom CSS with Tailwind utilities where feasible.
- [ ] Runs: remove page breadcrumb/header chrome while retaining the run list; support API search qualifiers such as `repo:octocat` and `owner:cloud-cli`; remove only the “Older Flow runs are available.” text.
- [ ] Workflows: remove breadcrumb/header chrome; row actions are icon-only buttons with accessible labels; show revisions as `vX`; remove redundant icon before workflow name/revision; add space between workflow tabs and the workflow list.
- [ ] Settings: move Workers under Settings; show worker list there; secret names truncate and columns align; remove workflow editor from Settings; retain secret management, tokens, timezone, and admin roster.
- [ ] Sidebar: render signed-in user's name/email/role; style role as a small badge; profile link opens `OIDC_PROVIDER + '/me'` in a new tab with external-link icon.

## Verification and delivery
- [ ] Add/update focused tests for the scoped behavior.
- [ ] Run Prettier, ESLint autofix + validation, test suite, and build; inspect the final diff and working-tree safety.
- [ ] Verify preview visually/browser-side if available; commit and push only task files, then inspect CI and deployment smoke test.
