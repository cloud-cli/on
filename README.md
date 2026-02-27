# on monorepo

Node.js monorepo powered by **Nx**.

## Workspace

- `packages/on`: Initial CLI package and future plugin host.

## Development

```bash
npm ci
npm run lint
npm run test
npm run build
```

## Release flow

- Releases are triggered from `main` via `.github/workflows/release.yml`.
- Nx release uses Conventional Commit messages to determine version bumps.
- The `on` package is published to npm using the `NPM_TOKEN` secret.
