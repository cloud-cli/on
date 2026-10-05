# New UI cutover checklist

## Completed
- [x] Repair the live preview module syntax error and add a parse regression test (`34393e7`).
- [x] Remove inaccurate run-range/page totals and periodic polling; preserve event-driven refresh and previous/next navigation (`9ccc56c`).
- [x] Verify local OIDC sign-in, Docker build, Playwright desktop/mobile runs, and clean up the temporary Auth Lab client.
- [x] Add admin-only `GET /api/users` and `PUT /api/users/{subject}/role`, protect the final administrator, and update sessions for the target user.
- [x] Add API/OpenAPI and focused repository, authorization, and role-propagation tests for user management.
- [x] Make the new live UI the default for `/` and route legacy URLs to compatible new-UI hash routes.
- [x] Update app-router to support hash-based new UI routing and legacy redirects.
- [x] Remove the redundant top bar and the Apphor/Engineering workspace sidebar block; remove the hardcoded user chip from the top bar.
- [x] Update UI concept index.html to remove sidebar/brand block.
- [x] Update UI concept app.js: remove workers from navigation, update settings page with API tokens, update workflows page with icon-only action buttons.

## Active work

- [ ] Use workflow YAML `name` as the visible workflow label everywhere; stop displaying internal workflow IDs; remove the workflow-ID input and generate an immutable random internal ID for new workflows.
- [ ] Finish the new-design workflow editor: load/create, YAML editing, validate, save draft, enable/disable, publish, run, delete, revision viewing/diff, and syntax/help.
- [ ] In the workflow list, use consistently spaced icon-only action buttons on mobile, with accessible names; retain clear desktop labels.
- [ ] Remove the "Older Flow runs are available" hint and fix workflow-filter reset to refetch unfiltered runs.
- [ ] Ellipsize long secret names; remove workflow editing from Settings.
- [ ] Add volatile, one-time API token issue/list/revoke controls to Settings.
- [ ] Add the admin-only user roster and role controls to the new Settings UI.
- [ ] Slightly darken the mobile bottom-navigation background.
- [ ] Add/adjust tests for editor, filters, user-role authorization, and UI behavior; run Prettier, ESLint, tests, and build.
- [ ] Review the complete diff; commit and push each functional change; inspect CI and smoke-test the deployed UI.
