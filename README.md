# on

A Node.js CLI tool for general-purpose automation, powered by **Nx** in a monorepo setup.

## Workspace

- `packages/on`: CLI package and plugin host for webhook-based automation.

## Development

```bash
pnpm i
pnpm run lint
pnpm run test
pnpm run build
```

## CI/CD

- Continuous integration runs on pull requests and pushes to `main` via `.github/workflows/ci.yml`.
- Releases are automated from `main` using `.github/workflows/release.yml`, with Nx handling versioning based on Conventional Commits.
- The `on` package is published to npm using the `NPM_TOKEN` secret. on monorepo

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
