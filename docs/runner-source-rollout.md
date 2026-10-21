# Runner source rollout progress

Updated 2026-10-20.

## Interim runner deployment

To bypass the npm package publication path while the Go runner is developed, the current Node API worker was built from source commit `35c916bf72b49c0d0089d1229abe59504f690d47` and deployed to the three existing Flow2 worker services. The service credentials, coordinator URLs, names, scheduling labels, and concurrency settings were preserved. The build artifact SHA-256 was identical on all three hosts: `27bb933bdb1015d5c960a5f3ad0f1c5b888a126796efbac5ce0327e900185eed`.

The source build passed `pnpm test:worker-artifact`; the worker artifact starts without database configuration. Each deployed service is active, and the coordinator reports its existing runner online with zero active jobs. This is a source-built Node worker, not the Go runner, and it still requires Node and pnpm for source installation/build. No npm package was published.

Rollback for a Flow2 worker is to remove its source-build drop-in at `/etc/systemd/system/runner-worker-flow2.service.d/20-source-build.conf`, run `systemctl daemon-reload`, and restart `runner-worker-flow2.service`. The previous worker files were left in place.

## Smoke-test result and current boundary

A push to the private migration-test repository was processed successfully by the source-built worker. The workflow ran its pending-status and payload-normalization steps and produced the expected repository, branch, commit SHA, and message. Although the published test workflow contains a `post:` final-status step, the coordinator did not include that step in the assigned execution: the run report contained only the two regular steps. The test commit was marked `error` rather than left with a misleading pending status. This indicates coordinator support for `post:` must be brought up to date before workflow-owned final status reporting is considered verified.

No production workflow, organization webhook, legacy Flow endpoint, or GitHub preprocessor/plugin was changed in this rollout. Production cutover remains a separate step requiring successful coordinator/worker lifecycle testing.

## Next steps

1. Update and validate the coordinator path so published `post:` steps reach runner assignments; rerun the private test workflow and confirm its final GitHub status.
2. Continue the Go runner beyond its current transport/config foundation, keeping the interim source-built worker available for rollback.
3. Perform the production Flow2 workflow/webhook cutover only after explicitly approved and tested.
