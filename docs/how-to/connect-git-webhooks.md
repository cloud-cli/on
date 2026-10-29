# Connect a GitHub or Gitea webhook

Workspace webhooks have their own random URL and signing secret. The URL identifies the target workspace; the
secret authenticates the provider's request body. Create a separate registration for each provider integration.

## Create the registration

As a workspace admin, open **Settings → Webhooks**, enter `github` or `gitea` as the webhook slug, and choose
**Create webhook**. Copy the generated URL and signing secret immediately; the secret is displayed only once.
Store it in the source-control provider's webhook settings, not in workflow YAML.

## Configure GitHub

In the repository's webhook settings:

1. Set the payload URL to the generated On URL.
2. Set the content type to `application/json`.
3. Set the secret to the generated signing secret.
4. Subscribe to **Just the push event** for the workflow in the tutorial.
5. Save the webhook and use the provider's recent-delivery view to verify the response.

GitHub requests are checked against the original body bytes using `X-Hub-Signature-256`. Valid push payloads are
normalized into workflow inputs such as `event`, `owner`, `repo`, `branch`, `tag`, `full_name`, `clone_url`,
`commit_sha`, `action`, and `changes`.

## Configure Gitea

Create a Gitea webhook with the generated URL and signing secret. Enable push events and JSON delivery. Gitea
signatures are checked against the original body bytes using `X-Gitea-Signature`; accepted push payloads are
normalized to the same core inputs as GitHub.

## Match a workflow

Use the provider name in the workflow trigger and constrain it to the intended repository:

```yaml
on:
  github:
    events: [push]
    owner: acme
    repo: web-app
    branches: [main]
```

Use `gitea` for a Gitea registration. The configured provider filters are combined with AND; values within one
filter list are alternatives. See [Workflow syntax](../reference/workflow-syntax.md) for filter details.

## Custom provider slugs

An unrecognized provider slug is a signed ingress alias, not a provider-specific parser. It currently requires a
GitHub-compatible `X-Hub-Signature-256` signature. A valid JSON body is exposed as `inputs.body` and `inputs.raw`,
with an allowlist of event metadata headers under `inputs.request.headers`. It is not normalized to GitHub or
Gitea inputs, and `inputs.raw` is parsed JSON rather than the original bytes. Use this mode only when the sender's
signature format is compatible; otherwise put a verified adapter in front of On.

Revoke a compromised registration from **Settings → Webhooks** and create a new one. Revocation immediately
invalidates its URL and signing secret.
