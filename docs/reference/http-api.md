# HTTP API reference

The versioned API is rooted at `/api/v1`. The live OpenAPI document is served from `GET /api/v1`; the checked-in
contract is [`openapi.json`](../../openapi.json). `/api` remains a compatibility alias.

The API covers workflow authoring and runs, workspace membership and secrets, webhook registration, runner
enrollment and leases, recipes, events, streams, and notifications. Use the OpenAPI contract for exact paths,
request schemas, responses, and authentication requirements; do not infer routes from UI URLs.

## Authentication and workspace scope

- Browser access uses the OIDC session created by `/auth/login` and `/auth/callback`.
- API access can use an approved Bearer token. The token identifies a principal; it does not bypass workspace
  membership.
- Workspace-scoped requests identify their workspace through `X-Team-ID` where the operation does not include it
  in the path. The server checks the principal's current membership and capability on each request.
- Runner routes use the individual runner's Bearer credential. Lease operations also require the lease token
  described by the OpenAPI schema.
- Runner enrollment codes are single-use and expire. The credential returned on enrollment is a secret; store it
  in a private file or secret-backed volume.

The OpenAPI document identifies operations that accept OIDC sessions, user tokens, or runner credentials.
Respect those scopes and use HTTPS outside loopback.
