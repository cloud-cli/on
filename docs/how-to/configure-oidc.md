# Configure OIDC sign-in

On uses OIDC for interactive sign-in and API access. Configure the OIDC provider and its client before inviting
users or exposing the web app.

## Register the client

Register an authorization-code client with a client secret. Add the exact public redirect URI:

```text
https://on.example.net/auth/callback
```

On requests `openid profile email offline_access`, uses PKCE with `S256`, and refreshes access tokens. The client
must permit the configured application origin.

## Configure the control plane

Set these values in the control-plane service environment:

```ini
OIDC_ISSUER=https://auth.example.net
OIDC_CLIENT_ID=<client-id>
OIDC_CLIENT_SECRET=<client-secret>
```

The issuer is the provider's issuer base URL, not the application's callback URL. Keep the client secret on the
control-plane host only. Restart `runner-server.service` after changing these values.

## Configure the reverse proxy

Forward the original host and HTTPS scheme to On using `X-Forwarded-Host` and `X-Forwarded-Proto`. On constructs
the callback URL from those headers. Configure the proxy to replace incoming forwarding headers rather than trust
values supplied by an internet client. The browser session cookie is marked `Secure` when the forwarded scheme is
HTTPS.

## First sign-in and administration

The first sign-in creates an identity, not a workspace. The user can create a workspace from the onboarding page;
its creator is that workspace's admin. Membership and permissions are checked independently for each workspace.

Platform-wide operations, such as managing shared runners, require platform administrator authority. Bootstrap a
platform admin only through an approved operator process, after the account has signed in at least once:

```sh
DATABASE_URL='<database-module-url>' on promote-admin --subject '<exact-oidc-subject>'
```

The subject is the stable OIDC `sub` value. Treat this as a sensitive database administration command; do not grant
platform-wide access when workspace administration is sufficient.
